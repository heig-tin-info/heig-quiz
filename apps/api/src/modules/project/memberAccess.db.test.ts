/**
 * Each member's access to a group's repository on GitHub (F-PROJ-07,
 * ADR-070's amendment of 2026-11-19), on a server built with Quiz's App
 * against the fake GitHub (`./testing.ts`):
 *
 * - the `member` webhook: `added` joins the member's grant (and the group's
 *   row), `removed` takes it back, the row left as the aggregate;
 * - the daily reconciliation: a member found in is joined, one found gone
 *   (no invitation, or one GitHub reports expired) is `expired` — never
 *   without that check — and is re-invited once a day per member, the claim
 *   on their grant, which reads the freeze itself;
 * - the backfill of 0145, the group's grants pending until checked;
 * - the staff's page names each member's state; the student's view carries
 *   the caller's own invitation and nothing of a teammate's.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { ProjectDetail, StudentProject } from "@quiz/contracts";

import { projectRepoAccess, projectRepos, webhookDeliveries } from "../../db/schema.js";
import { signedDelivery } from "../../github/testing.js";
import { WEBHOOK_SECRET } from "../../test/projectWorld.js";
import {
  accept,
  acceptInvitation,
  auditsOf,
  call,
  config,
  freshOrgId,
  gh,
  grantsOf,
  groupProject,
  newStudent,
  NOW,
  on,
  repoRows,
  server,
  staff,
  useGroupWorld,
  world,
  type Student,
} from "./groupTesting.js";
import { reconcileRepos } from "./reconcile.js";

useGroupWorld();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (plusMs: number) => new Date(Date.parse(NOW) + plusMs);

/** A group of four: Ana accepts (the repository made, every linked member invited), Dan has no linked account. */
async function group() {
  const [ana, ben, cid, dan] = [await newStudent(), await newStudent(), await newStudent(), await newStudent({ linked: false })];
  const { project, room } = await groupProject([ana!, ben!, cid!, dan!], [[0, 1, 2, 3]]);
  const res = await accept(project.id, ana!);
  expect(res.statusCode, res.body).toBe(200);
  const fullName = `${room.login}/lab-1-group-1`;
  const [row] = await repoRows(project.id);
  return { project, room, fullName, row: row!, ana: ana!, ben: ben!, cid: cid!, dan: dan! };
}
type Group = Awaited<ReturnType<typeof group>>;

const grantOf = async (repoId: string, who: Student) => (await grantsOf(repoId)).find((g) => g.githubUserId === who.githubUserId)!;
/** The invitation of `login` gone from GitHub (expired or declined): neither invited nor a collaborator. */
function gone(fullName: string, login: string) {
  world.collaborators.get(fullName)?.delete(login);
  const pending = world.invitations.get(fullName);
  for (const [id, who] of pending ?? []) if (who === login) pending!.delete(id);
}
/** Every grant of the repository invited `ms` earlier than it was. */
const backdate = (repoId: string, ms: number) =>
  server.app.db
    .update(projectRepoAccess)
    .set({ invitedAt: sql`${projectRepoAccess.invitedAt} - make_interval(secs => ${ms / 1000})` })
    .where(eq(projectRepoAccess.repoId, repoId));
/** The repository frozen for good an hour ago. */
const freeze = (repoId: string) =>
  server.app.db.update(projectRepos).set({ frozenAt: at(-HOUR), deadlineAppliedAt: at(-HOUR) }).where(eq(projectRepos.id, repoId));
const puts = (fullName: string, before: number) => gh.calls.slice(before).filter((c) => c.startsWith(`PUT api.github.com/repos/${fullName}/collaborators/`));

/** Each roster line's access, as the staff's page names it, by the member. */
async function staffStates(g: Group): Promise<Record<string, string | null>> {
  const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${g.project.id}`)).json());
  const lineOf = (who: Student) => g.room.lines.get(who.id);
  const names = { ana: g.ana, ben: g.ben, cid: g.cid, dan: g.dan };
  return Object.fromEntries(Object.entries(names).map(([name, who]) => [name, detail.rows.find((r) => r.student.enrollmentId === lineOf(who))!.access]));
}

async function handled(event: string, payload: object): Promise<void> {
  const id = randomUUID();
  const res = await signedDelivery(server.app, WEBHOOK_SECRET, payload, { event, id });
  expect(res.statusCode, res.body).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.error ?? null).toBeNull();
    expect(row?.processedAt).not.toBeNull();
  });
}
const member = (g: Group, who: Student, action: "added" | "removed") =>
  handled("member", { action, repository: { id: g.row.githubRepoId }, member: { id: who.githubUserId, login: who.login } });

describe("the member webhook", () => {
  it("joins the member's own grant on added, the group's row accepted; removed takes it back, the row kept", async () => {
    const g = await group();
    expect(g.row.invitationStatus).toBe("pending");
    expect(await staffStates(g)).toEqual({ ana: "pending", ben: "pending", cid: "pending", dan: "unlinked" });

    acceptInvitation(g.fullName, g.ben.login);
    await member(g, g.ben, "added");
    expect((await grantOf(g.row.id, g.ben)).acceptedAt).not.toBeNull();
    expect((await grantOf(g.row.id, g.ana)).acceptedAt).toBeNull();
    expect((await repoRows(g.project.id))[0]!.invitationStatus).toBe("accepted");
    expect(await staffStates(g)).toEqual({ ana: "pending", ben: "joined", cid: "pending", dan: "unlinked" });

    await member(g, g.ben, "removed");
    expect((await grantOf(g.row.id, g.ben)).acceptedAt).toBeNull();
    // The row is the group's aggregate: nothing else that reads it changes.
    expect((await repoRows(g.project.id))[0]!.invitationStatus).toBe("accepted");
    expect((await staffStates(g)).ben).toBe("pending");
  });

  it("changes nothing for an account Quiz never invited there (a collaborator the staff added on GitHub)", async () => {
    const g = await group();
    const outsider = await newStudent();
    await member(g, outsider, "added");
    expect((await repoRows(g.project.id))[0]!.invitationStatus).toBe("pending");
    expect(await staffStates(g)).toEqual({ ana: "pending", ben: "pending", cid: "pending", dan: "unlinked" });
  });
});

describe("the daily reconciliation of a group's members", () => {
  it("joins a member found in, says expired only after a check, re-invites the member gone once a day", async () => {
    const g = await group();
    acceptInvitation(g.fullName, g.ana.login);
    gone(g.fullName, g.cid.login);
    await backdate(g.row.id, 8 * DAY);
    // Cid's invitation gone from GitHub, but nobody looked: pending, never expired.
    expect(await staffStates(g)).toEqual({ ana: "pending", ben: "pending", cid: "pending", dan: "unlinked" });

    let before = gh.calls.length;
    await reconcileRepos(server.app, config);
    // One listing of each kind for the group, whatever its size.
    expect(gh.calls.slice(before).filter((c) => c === `GET api.github.com/repos/${g.fullName}/collaborators`)).toHaveLength(1);
    expect(gh.calls.slice(before).filter((c) => c === `GET api.github.com/repos/${g.fullName}/invitations`)).toHaveLength(1);
    // Ana in: joined, the row accepted. Cid gone: invited again, with push, through the one invitation path.
    expect(puts(g.fullName, before)).toEqual([`PUT api.github.com/repos/${g.fullName}/collaborators/${g.cid.login}`]);
    expect(world.collaborators.get(g.fullName)?.get(g.cid.login)).toBe("push");
    const cid = await grantOf(g.row.id, g.cid);
    expect(cid.reinvitedAt?.toISOString()).toBe(NOW);
    expect(cid.invitedAt.toISOString()).toBe(NOW);
    expect((await repoRows(g.project.id))[0]!.invitationStatus).toBe("accepted");
    expect(await staffStates(g)).toEqual({ ana: "joined", ben: "pending", cid: "pending", dan: "unlinked" });
    const invites = await auditsOf(g.row.id, "project_group.repo_invite");
    expect(invites.filter((a) => (a.payload as { via: string }).via === "reconcile").map((a) => a.payload)).toEqual([
      { repo: g.fullName, enrollmentId: g.room.lines.get(g.cid.id), login: g.cid.login, invitation: "pending", via: "reconcile" },
    ]);

    // Gone again the same day: the day is claimed, so it says expired until tomorrow's re-invite.
    gone(g.fullName, g.cid.login);
    server.clock.set(at(HOUR).toISOString());
    before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(puts(g.fullName, before)).toEqual([]);
    expect((await grantOf(g.row.id, g.cid)).absentAt?.toISOString()).toBe(at(HOUR).toISOString());
    expect(await staffStates(g)).toEqual({ ana: "joined", ben: "pending", cid: "expired", dan: "unlinked" });

    // A day on: invited again, pending again.
    server.clock.set(at(DAY + HOUR).toISOString());
    before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(puts(g.fullName, before)).toEqual([`PUT api.github.com/repos/${g.fullName}/collaborators/${g.cid.login}`]);
    expect((await staffStates(g)).cid).toBe("pending");

    // Everyone in: the next pass asks GitHub nothing about this repository's invitations.
    acceptInvitation(g.fullName, g.ben.login);
    acceptInvitation(g.fullName, g.cid.login);
    await reconcileRepos(server.app, config);
    expect(await staffStates(g)).toEqual({ ana: "joined", ben: "joined", cid: "joined", dan: "unlinked" });
    before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(gh.calls.slice(before).filter((c) => c.startsWith(`GET api.github.com/repos/${g.fullName}/`) && /collaborators|invitations/.test(c))).toEqual([]);
  });

  it("takes an invitation GitHub still lists but reports expired for gone, and re-invites its member", async () => {
    const g = await group();
    const [id] = [...world.invitations.get(g.fullName)!].find(([, who]) => who === g.cid.login)!;
    world.expiredInvitations.add(id);
    const before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(puts(g.fullName, before)).toEqual([`PUT api.github.com/repos/${g.fullName}/collaborators/${g.cid.login}`]);
    expect((await grantOf(g.row.id, g.cid)).reinvitedAt?.toISOString()).toBe(NOW);
    // Ben's invitation, still offered, is left alone.
    expect((await grantOf(g.row.id, g.ben)).reinvitedAt).toBeNull();
    world.expiredInvitations.delete(id);
  });

  it("re-invites nobody on a repository frozen while the pass ran: the claim reads the freeze, not the pass's snapshot", async () => {
    const g = await group();
    gone(g.fullName, g.cid.login);
    // Frozen after the pass loaded its candidates, before it claims the day.
    on({ match: (url, method) => method === "GET" && url.pathname === `/repos/${g.fullName}/invitations`, run: () => freeze(g.row.id).then(() => undefined) });
    const before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(puts(g.fullName, before)).toEqual([]);
    expect((await grantOf(g.row.id, g.cid)).reinvitedAt).toBeNull();
    expect((await staffStates(g)).cid).toBe("expired");
  });

  it("re-invites nobody once the repository is frozen: the member stays expired", async () => {
    const g = await group();
    gone(g.fullName, g.cid.login);
    await freeze(g.row.id);
    const before = gh.calls.length;
    await reconcileRepos(server.app, config);
    expect(puts(g.fullName, before)).toEqual([]);
    expect((await grantOf(g.row.id, g.cid)).reinvitedAt).toBeNull();
    expect((await staffStates(g)).cid).toBe("expired");
  });
});

describe("the backfill of 0145", () => {
  it("joins the live grants of a student's own accepted repository only; a group's stay pending until the reconciliation checks them", async () => {
    const g = await group();
    await server.app.db.update(projectRepos).set({ invitationStatus: "accepted" }).where(eq(projectRepos.id, g.row.id));
    // An individual repository whose row says accepted, its grant not joined (as before 0145).
    const [solo] = [await newStudent()];
    const { project, room } = await groupProject([solo!], [[0]]);
    const soloRepo = randomUUID();
    await server.app.db.insert(projectRepos).values({
      id: soloRepo,
      projectId: project.id,
      userId: solo!.id,
      fullName: `${g.room.login}/solo`,
      githubRepoId: freshOrgId(),
      provisionStatus: "ok",
      invitationStatus: "accepted",
      acceptedAt: new Date(NOW),
    });
    await server.app.db.insert(projectRepoAccess).values({
      id: randomUUID(),
      repoId: soloRepo,
      enrollmentId: room.lines.get(solo!.id)!,
      githubUserId: solo!.githubUserId,
      githubLogin: solo!.login,
      invitedAt: at(-30 * DAY),
    });

    const migration = readFileSync(new URL("../../../drizzle/0145_project_member_access.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf('UPDATE "project_repo_access" AS a SET "accepted_at"'));
    await server.app.db.execute(sql.raw(backfill.slice(0, backfill.indexOf("--> statement-breakpoint"))));
    expect((await grantsOf(soloRepo))[0]!.acceptedAt).not.toBeNull();
    expect((await grantsOf(g.row.id)).every((grant) => grant.acceptedAt === null)).toBe(true);
    // Never checked: pending, never expired.
    expect(await staffStates(g)).toEqual({ ana: "pending", ben: "pending", cid: "pending", dan: "unlinked" });

    // The next daily pass checks them, one listing each for the repository.
    acceptInvitation(g.fullName, g.ana.login);
    acceptInvitation(g.fullName, g.ben.login);
    gone(g.fullName, g.cid.login);
    await freeze(g.row.id);
    await reconcileRepos(server.app, config);
    expect(await staffStates(g)).toEqual({ ana: "joined", ben: "joined", cid: "expired", dan: "unlinked" });
  });
});

describe("the student's view of a group's repository", () => {
  it("carries the caller's own invitation, the group's work all the same, and nothing of a teammate's access", async () => {
    const g = await group();
    acceptInvitation(g.fullName, g.ana.login);
    gone(g.fullName, g.cid.login);
    await member(g, g.ana, "added");
    // Cid's invitation found gone (the day already claimed): expired.
    await server.app.db.update(projectRepoAccess).set({ reinvitedAt: new Date(NOW) }).where(eq(projectRepoAccess.githubUserId, g.cid.githubUserId));
    await reconcileRepos(server.app, config);
    expect((await staffStates(g)).cid).toBe("expired");

    const viewOf = async (who: Student) => {
      const res = await call("GET", `/app/api/student/projects/${g.project.id}`, who.headers);
      expect(res.statusCode, res.body).toBe(200);
      return { body: res.body, view: StudentProject.parse(res.json()) };
    };
    // Ana is in: accepted, and the group's work (its commits, its CI state) is hers to read.
    const ana = await viewOf(g.ana);
    expect(ana.view.repo).toMatchObject({ fullName: g.fullName, invitation: "accepted" });
    expect(ana.view.repo).not.toHaveProperty("group");
    // Cid's own invitation expired: hers to resend, said pending; the same repository, the same work.
    const cid = await viewOf(g.cid);
    expect(cid.view.repo).toMatchObject({ fullName: g.fullName, invitation: "pending" });
    expect(cid.view.repo!.commits).toBe(ana.view.repo!.commits);
    expect(cid.view.repo!.ciStatus).toBe(ana.view.repo!.ciStatus);
    // Dan has no linked account: no invitation of his.
    expect((await viewOf(g.dan)).view.repo?.invitation).toBeNull();

    // Nothing of a teammate's access or login, on the page or the home's card.
    for (const [who, others] of [
      [g.ana, [g.ben, g.cid, g.dan]],
      [g.cid, [g.ana, g.ben, g.dan]],
    ] as const) {
      const bodies = [(await viewOf(who)).body, (await call("GET", "/app/api/student/home", who.headers)).body];
      for (const body of bodies) {
        expect(body).not.toMatch(/expired|unlinked|absentAt|reinvitedAt/);
        for (const other of others) expect(body).not.toContain(other.login);
      }
    }
    const card = (await call("GET", "/app/api/student/home", g.cid.headers)).json() as { open: { id: string; invitation: string | null }[] };
    expect(card.open.find((c) => c.id === g.project.id)?.invitation).toBe("pending");
  });
});
