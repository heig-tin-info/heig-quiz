/**
 * The follow on GitHub (ADR-070 §4, §6 and its amendment of 2026-10-05,
 * F-PROJ-06/13; merge task M3-15b-2), on the group repositories' world
 * (`groupTesting.ts`): the `group.sync` job is run by hand — no queue in
 * the tests —, each interleaving through the fake GitHub's one-shot hooks.
 *
 * - confirmations: a move reaching a group with a repository answers `409
 *   needs_confirmation` with its consequences and their digest; a digest
 *   another write made stale is asked again; a write that adds nothing
 *   (an unrelated one, a move back) is applied at once;
 * - the job: a move between two following groups (revoked, then moved,
 *   then invited), an arrival, a P1 skip (the App gone, a student never
 *   invited), a refused revocation (*access to revoke*, the backoff, the
 *   retry), two projects on one set where one fails, a crashed job's lease
 *   taken over, a roster removal while a move waits;
 * - the races: an Accept, a GitHub link, a resend during a pending
 *   departure (refused); the project's stop landing between the revocation
 *   and the copy write (the departure completes, the arrival skipped); the
 *   set putting the student back meanwhile (invited again); an account
 *   recorded since the revocation (refused, then revoked);
 * - a revocation counts once GitHub confirmed it (`revoking_at`): a roster
 *   removal during the job's refused revocation is refused (502); a job
 *   that crashed after its mark is asked again; a stray access (an
 *   invitation GitHub would not take back) is flagged and retried;
 * - the per-group stop: a repository's deadline earlier than the project's
 *   stops its group for good — no rename, no move, even once extended —; a
 *   departure whose group stopped before its revocation began is held,
 *   nothing revoked; the backfill of 0068 (the audit log's first
 *   application included).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { GroupConsequences, GroupSetDetail, ProjectDetail, ProjectSummary } from "@quiz/contracts";

import { auditLog, githubOrganizations, projectGroupMembers, projectGroups, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { inviteOnGithubLink } from "./access.js";
import {
  accept,
  acceptInvitation,
  acceptRefusal,
  accounts,
  auditsOf,
  call,
  config,
  freshAccountId,
  gh,
  groupOf,
  groupProject,
  groupRefusal,
  IN_A_WEEK,
  link,
  moveTo,
  newStudent,
  NOW,
  on,
  pendingInvitations,
  removeLine,
  repoRows,
  seats,
  server,
  setOk,
  staff,
  useGroupWorld,
  world,
  type Student,
} from "./groupTesting.js";
import { beginDeparture } from "./groupCopy.js";
import { claimGroupSyncWork, runGroupSyncJob } from "./groupSync.js";
import { projectTick } from "./jobs.js";
import { FAILED_RETRY_MS, LEASE_MS } from "./lease.js";

useGroupWorld();

const db = () => server.app.db;
const later = (ms: number) => server.clock.set(new Date(Date.parse(NOW) + ms).toISOString());

/** The move of `line` asked (`409 needs_confirmation`), then sent again with the digest: applied. The consequences. */
async function confirmMove(set: GroupSetDetail, line: string, groupId: string | null): Promise<GroupConsequences> {
  const asked = await moveTo(set, line, groupId);
  expect(groupRefusal(asked)).toEqual([409, "needs_confirmation"]);
  const details = GroupConsequences.parse(asked.json());
  const done = await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line}`, { groupId, confirm: details.digest });
  expect(done.statusCode, done.body).toBe(200);
  return details;
}

/** The project's `group.sync` job, claimed and run as the queue would; the jobs run. */
async function sync(projectId: string): Promise<number> {
  const jobs = await claimGroupSyncWork(db(), server.app.clock.now(), projectId);
  for (const job of jobs) await runGroupSyncJob(server.app, config, job);
  return jobs.length;
}

/** Where `line` is in the project's copy: its group's name and its pending departure; null when in none. */
async function placeOf(projectId: string, line: string) {
  const [row] = await db()
    .select({ group: projectGroups.name, departing: projectGroupMembers.departingAt })
    .from(projectGroupMembers)
    .innerJoin(projectGroups, eq(projectGroups.id, projectGroupMembers.groupId))
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, line)));
  return row ? { group: row.group, departing: row.departing !== null } : null;
}

const dueOf = async (projectId: string) => (await db().select({ due: projects.groupSyncDueAt }).from(projects).where(eq(projects.id, projectId)))[0]!.due;
const repoOf = async (projectId: string, fullName: string) => (await repoRows(projectId)).find((r) => r.fullName === fullName)!;

/** Two groups, each with its repository: Ana and Ben in Group 1, Cid in Group 2 (Ben's invitation accepted). */
async function twoRepos() {
  const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
  const { project, room, set } = await groupProject([ana!, ben!, cid!], [[0, 1], [2]]);
  expect((await accept(project.id, ana!)).statusCode).toBe(200);
  expect((await accept(project.id, cid!)).statusCode).toBe(200);
  const [a, b] = [`${room.login}/lab-1-group-1`, `${room.login}/lab-1-group-2`];
  acceptInvitation(a, ben!.login);
  return { project, room, set, ana: ana!, ben: ben!, cid: cid!, a, b, line: (s: Student) => room.lines.get(s.id)! };
}

// ---------------------------------------------------------------- confirmations

describe("a set's write with GitHub consequences (ADR-070 §6)", () => {
  it("names them with their digest; confirmed, the set moves and the copy waits for the job", async () => {
    const { project, set, ben, a, b, line } = await twoRepos();
    const asked = await moveTo(set, line(ben), groupOf(set, "Group 2").id);
    expect(groupRefusal(asked)).toEqual([409, "needs_confirmation"]);
    const details = GroupConsequences.parse(asked.json());
    expect(details.digest).toMatch(/^[0-9a-f]{64}$/);
    const named = details.consequences.map((c) => [c.projectName, c.groupName, c.repo, c.enrollmentId, c.kind]);
    expect(named).toHaveLength(2);
    expect(named).toEqual(
      expect.arrayContaining([
        ["Lab 1", "Group 1", a, line(ben), "lose"],
        ["Lab 1", "Group 2", b, line(ben), "join"],
      ]),
    );
    // A wrong digest is asked again, nothing written.
    const wrong = await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line(ben)}`, { groupId: groupOf(set, "Group 2").id, confirm: "0".repeat(64) });
    expect([groupRefusal(wrong), wrong.json().digest]).toEqual([[409, "needs_confirmation"], details.digest]);

    const done = await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line(ben)}`, { groupId: groupOf(set, "Group 2").id, confirm: details.digest });
    const after = await setOk(done);
    expect(groupOf(after, "Group 2").members.map((m) => m.enrollmentId)).toContain(line(ben));
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: true });
    expect(await dueOf(project.id)).toEqual(new Date(NOW));
    const move = (await auditsOf(set.set.id, "group.member_move")).filter((m) => (m.payload as { enrollmentId: string }).enrollmentId === line(ben)).at(-1);
    expect(move!.payload).toMatchObject({ copies: [], deferred: [project.id] });
    // GitHub untouched until the job runs.
    expect(seats(a)[ben.login]).toBe("push");
  });

  it("asks again when another write made the digest stale, for what the write still adds", async () => {
    const { set, ben, line } = await twoRepos();
    const g2 = groupOf(set, "Group 2").id;
    const first = GroupConsequences.parse((await moveTo(set, line(ben), g2)).json());
    expect(first.consequences.map((c) => c.kind).sort()).toEqual(["join", "lose"]);
    // Another staff member's write: Ben out of every group, confirmed.
    await confirmMove(set, line(ben), null);
    const stale = await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line(ben)}`, { groupId: g2, confirm: first.digest });
    expect(groupRefusal(stale)).toEqual([409, "needs_confirmation"]);
    const fresh = GroupConsequences.parse(stale.json());
    expect([fresh.consequences.map((c) => c.kind), fresh.digest === first.digest]).toEqual([["join"], false]);
    const done = await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line(ben)}`, { groupId: g2, confirm: fresh.digest });
    expect(done.statusCode, done.body).toBe(200);
  });

  it("applies at once a write that adds none: an unrelated one, or the student put back (the departure dropped)", async () => {
    const { project, set, ben, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    await setOk(await staff("POST", `/app/api/group-sets/${set.set.id}/groups`, { name: "Group 3" }));
    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 2").id}`, { name: "Les Pandas" }));
    // Back where the copy has him: no confirmation, the mark dropped, nothing left for the job.
    await setOk(await moveTo(set, line(ben), groupOf(set, "Group 1").id));
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: false });
    expect(await sync(project.id)).toBe(1);
    expect(await dueOf(project.id)).toBeNull();
    expect(await auditsOf((await repoRows(project.id))[0]!.id, "project_group.repo_revoke")).toEqual([]);
  });
});

// ---------------------------------------------------------------- the job

describe("the group.sync job (ADR-070 §4)", () => {
  it("moves a student between two following groups: revoked, then moved, then invited", async () => {
    const { project, set, ben, a, b, line } = await twoRepos();
    await confirmMove(set, line(ben), groupOf(set, "Group 2").id);
    const before = gh.calls.length;
    expect(await sync(project.id)).toBe(1);
    expect(seats(a)[ben.login]).toBeUndefined();
    expect(pendingInvitations(b)).toContain(ben.login);
    // The revocation before the invitation.
    const writes = gh.calls.slice(before).filter((c) => /^(DELETE|PUT) /.test(c));
    expect(writes).toEqual([`DELETE api.github.com/repos/${a}/collaborators/${ben.login}`, `PUT api.github.com/repos/${b}/collaborators/${ben.login}`]);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 2", departing: false });
    expect(await dueOf(project.id)).toBeNull();
    const [ra, rb] = [await repoOf(project.id, a), await repoOf(project.id, b)];
    expect((await auditsOf(ra.id, "project_group.repo_revoke")).map((e) => e.payload)).toEqual([
      { repo: a, enrollmentId: line(ben), login: ben.login, via: "group.sync", outcome: "ok", invitationsCancelled: 0 },
    ]);
    expect((await auditsOf(rb.id, "project_group.repo_invite")).map((e) => e.payload)).toEqual([
      { repo: b, enrollmentId: line(ben), login: ben.login, invitation: "pending", via: "group.sync" },
    ]);
    // A second pass has nothing to do.
    expect(await sync(project.id)).toBe(0);
  });

  it("writes an arrival from a group without repository, then invites it", async () => {
    const dan = await newStudent();
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, dan], [[0, 1], [2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    const details = await confirmMove(set, room.lines.get(dan.id)!, groupOf(set, "Group 1").id);
    expect(details.consequences.map((c) => [c.groupName, c.kind])).toEqual([["Group 1", "join"]]);
    expect(await placeOf(project.id, room.lines.get(dan.id)!)).toMatchObject({ group: "Group 2" });
    await sync(project.id);
    expect(await placeOf(project.id, room.lines.get(dan.id)!)).toMatchObject({ group: "Group 1" });
    expect(pendingInvitations(a)).toContain(dan.login);
  });

  it("proceeds when there is nothing to take (P1): the App gone, a student never invited, audited skipped", async () => {
    const eve = await newStudent({ linked: false });
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, eve], [[0, 1, 2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    await confirmMove(set, room.lines.get(eve.id)!, null);
    await sync(project.id);
    expect(await placeOf(project.id, room.lines.get(eve.id)!)).toBeNull();
    await db().update(githubOrganizations).set({ installationId: null }).where(eq(githubOrganizations.id, room.orgId));
    await confirmMove(set, room.lines.get(ben!.id)!, null);
    await sync(project.id);
    expect(await placeOf(project.id, room.lines.get(ben!.id)!)).toBeNull();
    const skips = (await auditsOf(row!.id, "project_group.repo_revoke")).map((e) => e.payload as { reason: string; via: string; enrollmentId: string });
    expect(skips.map((p) => [p.enrollmentId, p.reason, p.via])).toEqual([
      [room.lines.get(eve.id), "not_invited", "group.sync"],
      [room.lines.get(ben!.id), "app_not_installed", "group.sync"],
    ]);
  });

  it("keeps a student GitHub refuses to revoke, flags access to revoke, backs off, and retries", async () => {
    const { project, set, ana, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    world.unrevokable.add(a);
    try {
      await expect(sync(project.id)).rejects.toThrow(/group.sync incomplete/);
      expect(seats(a)[ben.login]).toBe("push");
      expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: true });
      // The grant is live again: the roster's next revocation finds it.
      const [grant] = await db().select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, line(ben)));
      expect(grant!.revokedAt).toBeNull();
      const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${project.id}`)).json());
      const rowOf = (s: Student) => detail.rows.find((r) => r.student.enrollmentId === line(s))!;
      expect([rowOf(ana).repo?.accessToRevoke, rowOf(ben).repo?.accessToRevoke]).toEqual([true, true]);
      expect(await dueOf(project.id)).toEqual(new Date(Date.parse(NOW) + FAILED_RETRY_MS));
      // Not before the backoff; a second failure doubles it.
      expect(await sync(project.id)).toBe(0);
      later(FAILED_RETRY_MS);
      await expect(sync(project.id)).rejects.toThrow();
      expect(await dueOf(project.id)).toEqual(new Date(Date.parse(NOW) + 3 * FAILED_RETRY_MS));
    } finally {
      world.unrevokable.delete(a);
    }
    later(3 * FAILED_RETRY_MS);
    expect(await sync(project.id)).toBe(1);
    expect(seats(a)[ben.login]).toBeUndefined();
    expect(await placeOf(project.id, line(ben))).toBeNull();
    const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${project.id}`)).json());
    expect(detail.rows.some((r) => r.repo?.accessToRevoke)).toBe(false);
    expect((await db().select().from(projects).where(eq(projects.id, project.id)))[0]).toMatchObject({ groupSyncDueAt: null, groupSyncFailures: 0 });
  });

  it("runs each project of one set alone: one refused, the other moved", async () => {
    const { project, room, set, ben, a, line } = await twoRepos();
    const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, {
      name: "Lab 2",
      sourceRepo: "starter",
      deadlineAt: IN_A_WEEK,
      groupMode: true,
      groupSetId: set.set.id,
    });
    const second = ProjectSummary.parse(created.json());
    expect((await staff("POST", `/app/api/projects/${second.id}/publish`)).statusCode).toBe(200);
    expect((await accept(second.id, ben)).statusCode).toBe(200);
    const details = await confirmMove(set, line(ben), null);
    expect(details.consequences.map((c) => c.projectName).sort()).toEqual(["Lab 1", "Lab 2"]);
    world.unrevokable.add(a);
    try {
      await expect(sync(project.id)).rejects.toThrow();
      await sync(second.id);
    } finally {
      world.unrevokable.delete(a);
    }
    expect(await placeOf(project.id, line(ben))).toMatchObject({ group: "Group 1" });
    expect(await placeOf(second.id, line(ben))).toBeNull();
    const flagged = async (id: string) => ProjectDetail.parse((await staff("GET", `/app/api/projects/${id}`)).json()).rows.some((r) => r.repo?.accessToRevoke);
    expect([await flagged(project.id), await flagged(second.id)]).toEqual([true, false]);
    expect(seats(`${room.login}/lab-2-group-1`)[ben.login]).toBeUndefined();
  });

  it("takes over the work of a job that crashed holding its lease, once the lease expired", async () => {
    const { project, set, ben, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    const [crashed] = await claimGroupSyncWork(db(), server.app.clock.now(), project.id);
    expect(crashed).toBeDefined();
    expect(await sync(project.id)).toBe(0);
    later(LEASE_MS + 1000);
    const [next] = await claimGroupSyncWork(db(), server.app.clock.now(), project.id);
    // The crashed job, run late, finds its lease gone and does nothing.
    await runGroupSyncJob(server.app, config, crashed!);
    expect(await placeOf(project.id, line(ben))).toMatchObject({ departing: true });
    await runGroupSyncJob(server.app, config, next!);
    expect(await placeOf(project.id, line(ben))).toBeNull();
  });

  it("finds nothing to do for a student removed from the roster while their move waited", async () => {
    const { project, room, set, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    expect((await removeLine(room, line(ben))).statusCode).toBe(204);
    expect(seats(a)[ben.login]).toBeUndefined();
    expect(await sync(project.id)).toBe(1);
    expect(await dueOf(project.id)).toBeNull();
    const vias = (await auditsOf((await repoOf(project.id, a)).id, "project_group.repo_revoke")).map((e) => (e.payload as { via: string }).via);
    expect(vias).toEqual(["roster.remove"]);
  });
});

// ---------------------------------------------------------------- the races

describe("the races of a departure waiting for GitHub", () => {
  it("refuses an Accept, a GitHub link and a resend of the student leaving", async () => {
    const eve = await newStudent({ linked: false });
    const [ana] = [await newStudent()];
    const { project, room, set } = await groupProject([ana!, eve], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    await confirmMove(set, room.lines.get(eve.id)!, null);
    await link(eve.id, eve.githubUserId, eve.login);
    await inviteOnGithubLink(db(), config, eve.id, { now: new Date(NOW), log: server.app.log });
    expect(acceptRefusal(await accept(project.id, eve))).toEqual([409, "provision_in_progress"]);
    const own = await call("POST", `/app/api/student/projects/${project.id}/invite`, eve.headers);
    expect([own.statusCode, own.json().error]).toEqual([409, "repo_unavailable"]);
    const before = gh.calls.length;
    const [row] = await repoRows(project.id);
    expect((await staff("POST", `/app/api/projects/${project.id}/repos/${row!.id}/invite`)).statusCode).toBe(200);
    expect(gh.calls.slice(before).filter((c) => c.startsWith("PUT"))).toEqual([`PUT api.github.com/repos/${a}/collaborators/${ana!.login}`]);
    expect(seats(a)[eve.login]).toBeUndefined();
    expect(await db().select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, room.lines.get(eve.id)!))).toEqual([]);
  });

  it("completes a departure whose project stops between the revocation and the copy write; the arrival skipped", async () => {
    const { project, set, ben, a, b, line } = await twoRepos();
    await confirmMove(set, line(ben), groupOf(set, "Group 2").id);
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${a}/collaborators/${ben.login}`,
      run: async () => {
        server.clock.set("2026-10-13T00:00:00.000Z");
        await projectTick(server.app, config);
      },
    });
    await sync(project.id);
    expect((await db().select().from(projects).where(eq(projects.id, project.id)))[0]!.groupsStoppedAt).not.toBeNull();
    expect(seats(a)[ben.login]).toBeUndefined();
    expect(await placeOf(project.id, line(ben))).toBeNull();
    expect(pendingInvitations(b)).not.toContain(ben.login);
    expect(await dueOf(project.id)).toBeNull();
  });

  it("invites again a student the set put back while GitHub revoked them", async () => {
    const { project, set, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${a}/collaborators/${ben.login}`,
      run: async () => void (await setOk(await moveTo(set, line(ben), groupOf(set, "Group 1").id))),
    });
    await sync(project.id);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: false });
    expect(pendingInvitations(a)).toContain(ben.login);
  });

  it("refuses to move a student out while an account of theirs was recorded since the revocation, then revokes it", async () => {
    const { project, set, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    const row = await repoOf(project.id, a);
    const other = freshAccountId();
    accounts.set(other, `ben-other-${other}`);
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${a}/collaborators/${ben.login}`,
      run: async () =>
        void (await db()
          .insert(projectRepoAccess)
          .values({ id: randomUUID(), repoId: row.id, enrollmentId: line(ben), githubUserId: other, githubLogin: `ben-other-${other}`, invitedAt: new Date(NOW) })),
    });
    await expect(sync(project.id)).rejects.toThrow();
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: true });
    later(FAILED_RETRY_MS);
    await sync(project.id);
    expect(await placeOf(project.id, line(ben))).toBeNull();
    const logins = (await auditsOf(row.id, "project_group.repo_revoke")).map((e) => (e.payload as { login: string }).login);
    expect(logins).toEqual([ben.login, `ben-other-${other}`]);
  });
});

describe("a revocation counts only once GitHub confirmed it (revoking_at)", () => {
  it("refuses a roster removal while the job's revocation is under way and GitHub refuses it (502), never a silent cascade", async () => {
    const { project, room, set, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    world.unrevokable.add(a);
    let during: { statusCode: number; json: () => { error: unknown } } | undefined;
    try {
      on({
        match: (url, method) => method === "DELETE" && url.pathname === `/repos/${a}/collaborators/${ben.login}`,
        run: async () => void (during = await removeLine(room, line(ben))),
      });
      await expect(sync(project.id)).rejects.toThrow();
    } finally {
      world.unrevokable.delete(a);
    }
    expect([during!.statusCode, during!.json().error]).toEqual([502, "revoke_failed"]);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: true });
    expect(seats(a)[ben.login]).toBe("push");
    // GitHub takes it now: the removal's retry revokes and proceeds.
    expect((await removeLine(room, line(ben))).statusCode).toBe(204);
    expect(seats(a)[ben.login]).toBeUndefined();
  });

  it("asks GitHub again after a job crashed between the mark and GitHub's answer", async () => {
    const { project, room, set, ben, a, line } = await twoRepos();
    await confirmMove(set, line(ben), null);
    const [g1] = await db().select().from(projectGroups).where(and(eq(projectGroups.projectId, project.id), eq(projectGroups.name, "Group 1")));
    const marked = await beginDeparture(db(), project.id, line(ben), g1!.id, (await repoOf(project.id, a)).id, new Date(NOW));
    expect(marked).toHaveLength(1);
    // Marked, not revoked: it counts as live — the page flags it, a roster write GitHub refuses is refused.
    const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${project.id}`)).json());
    expect(detail.rows.find((r) => r.student.enrollmentId === line(ben))!.repo?.accessToRevoke).toBe(true);
    world.unrevokable.add(a);
    try {
      expect((await removeLine(room, line(ben))).statusCode).toBe(502);
    } finally {
      world.unrevokable.delete(a);
    }
    const before = gh.calls.length;
    expect(await sync(project.id)).toBe(1);
    expect(gh.calls.slice(before)).toContain(`DELETE api.github.com/repos/${a}/collaborators/${ben.login}`);
    expect(await placeOf(project.id, line(ben))).toBeNull();
    const [grant] = await db().select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, line(ben)));
    expect([grant!.revokedAt !== null, grant!.revokingAt]).toEqual([true, null]);
  });

  it("flags and retries a stray access: an invitation GitHub would not take back after the student moved out", async () => {
    const eve = await newStudent({ linked: false });
    const [ana] = [await newStudent()];
    const { project, room, set } = await groupProject([ana!, eve], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    const line = room.lines.get(eve.id)!;
    await link(eve.id, eve.githubUserId, eve.login);
    // Eve's Accept invites her; before GitHub answers, the set moves her out and the job revokes her.
    on({
      match: (url, method) => method === "PUT" && url.pathname === `/repos/${a}/collaborators/${eve.login}`,
      run: async () => {
        await confirmMove(set, line, null);
        await sync(project.id);
        world.unrevokable.add(a);
      },
    });
    try {
      expect((await accept(project.id, eve)).statusCode).not.toBe(200);
    } finally {
      world.unrevokable.delete(a);
    }
    expect(await placeOf(project.id, line)).toBeNull();
    const live = await db().select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, line));
    expect(live.map((g) => g.revokedAt)).toEqual([null]);
    const flagged = () => staff("GET", `/app/api/projects/${project.id}`).then((r) => ProjectDetail.parse(r.json()).rows.some((row) => row.repo?.accessToRevoke));
    expect(await flagged()).toBe(true);
    expect(await dueOf(project.id)).not.toBeNull();
    expect(await sync(project.id)).toBe(1);
    expect(await flagged()).toBe(false);
    expect(await dueOf(project.id)).toBeNull();
    expect(seats(a)[eve.login]).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the per-group stop

describe("a group stops at the first of its deadlines (the amendment of 2026-10-05)", () => {
  it("stops with its repository's earlier deadline, for good: no rename, no move, even once extended", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0], [1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const own = (at: string) => staff("PUT", `/app/api/projects/${project.id}/repos/${row!.id}/deadline`, { deadlineAt: at });
    expect((await own("2026-10-05T09:00:00.000Z")).statusCode).toBe(200);
    later(2 * 3_600_000);
    await projectTick(server.app, config);
    const stopped = async () =>
      Object.fromEntries(
        (await db().select().from(projectGroups).where(eq(projectGroups.projectId, project.id))).map((g) => [g.slug, g.stoppedAt !== null]),
      );
    expect(await stopped()).toEqual({ "group-1": true, "group-2": false });

    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 1").id}`, { name: "Renamed" }));
    // Into the stopped group: held whole, no confirmation, nothing waits.
    await setOk(await moveTo(set, room.lines.get(ben!.id)!, groupOf(set, "Group 1").id));
    expect(await placeOf(project.id, room.lines.get(ben!.id)!)).toMatchObject({ group: "Group 2" });
    expect(await dueOf(project.id)).toBeNull();

    expect((await own("2026-10-20T09:00:00.000Z")).statusCode).toBe(200);
    expect(await stopped()).toEqual({ "group-1": true, "group-2": false });
    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 1").id}`, { name: "Again" }));
    const names = (await db().select().from(projectGroups).where(eq(projectGroups.projectId, project.id))).map((g) => g.name).sort();
    expect(names).toEqual(["Group 1", "Group 2"]);
  });

  it("holds a departure whose group stops before its revocation began: nothing revoked, nothing audited", async () => {
    const dan = await newStudent();
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, dan], [[0, 1, 2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    const [row] = await repoRows(project.id);
    expect((await staff("PUT", `/app/api/projects/${project.id}/repos/${row!.id}/deadline`, { deadlineAt: "2026-10-05T09:00:00.000Z" })).statusCode).toBe(200);
    await confirmMove(set, room.lines.get(ben!.id)!, null);
    await confirmMove(set, room.lines.get(dan.id)!, null);
    // The first revocation's seat removal: the repository's deadline applies just before it.
    on({
      match: (url, method) => method === "DELETE" && url.pathname.startsWith(`/repos/${a}/collaborators/`),
      run: async () => {
        later(2 * 3_600_000);
        await projectTick(server.app, config);
      },
    });
    const before = gh.calls.length;
    await sync(project.id);
    const first = gh.calls.slice(before).find((c) => c.startsWith(`DELETE api.github.com/repos/${a}/collaborators/`))!.split("/").at(-1);
    const [gone, held] = first === ben!.login ? [ben!, dan] : [dan, ben!];
    expect(await placeOf(project.id, room.lines.get(gone.id)!)).toBeNull();
    expect(await placeOf(project.id, room.lines.get(held.id)!)).toEqual({ group: "Group 1", departing: false });
    expect(seats(a)[held.login]).toBe("push");
    const revoked = (await auditsOf(row!.id, "project_group.repo_revoke")).map((e) => (e.payload as { enrollmentId: string }).enrollmentId);
    expect(revoked).toEqual([room.lines.get(gone.id)]);
    expect(await dueOf(project.id)).toBeNull();
  });

  it("backfills each group's stop from the first of its project's stop and its repository's deadline (0068)", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project } = await groupProject([ana!, ben!], [[0], [1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const [first, second] = [new Date("2026-10-06T00:00:00.000Z"), new Date("2026-10-08T00:00:00.000Z")];
    // Applied first on the 6th, then reopened: only the audit log remembers it.
    await db().update(projectRepos).set({ deadlineAppliedAt: null }).where(eq(projectRepos.id, row!.id));
    await db()
      .insert(auditLog)
      .values({ actorType: "system", action: "project_repo.deadline_applied", subjectType: "project_repo", subjectId: row!.id, payload: {}, createdAt: first });
    await db().update(projects).set({ groupsStoppedAt: second }).where(eq(projects.id, project.id));
    const migration = readFileSync(new URL("../../../drizzle/0068_group_sync.sql", import.meta.url), "utf8");
    await db().execute(sql.raw(migration.slice(migration.indexOf('UPDATE "project_groups"'))));
    const groups = await db().select().from(projectGroups).where(eq(projectGroups.projectId, project.id));
    expect(Object.fromEntries(groups.map((g) => [g.slug, g.stoppedAt]))).toEqual({ "group-1": first, "group-2": second });
  });
});
