/**
 * *Resync with the set* and the drift (ADR-070 §4, §6 and its third
 * amendment of 2026-10-05, F-PROJ-13; merge task M3-15b-2b), on the group
 * repositories' world (`groupTesting.ts`): the `group.sync` job is run by
 * hand, each interleaving through the fake GitHub's one-shot hooks.
 *
 * - the confirmation: after the deadline every frozen repository named, a
 *   wrong and a stale digest asked again, nothing to resync a 204;
 * - the job: a frozen A→B move ends moved, audited `via: "group.resync"`;
 *   a set's write after the confirmation never applied; the copy stays
 *   stopped and drifts again;
 * - the product owner's R1 (a frozen group with a repository whose set
 *   group is gone kept), R2 (the release refused while a resync is owed),
 *   R3 (an arrival into a group without a repository once Accept is closed,
 *   flagged);
 * - a per-group stop on a following project; the refusals (a draft, an
 *   archived or released project); a roster removal during the resync's
 *   revocation (502); a repository's deadline applied mid-resync keeping
 *   the resync's marks.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { GroupConsequences, ProjectDetail, ProjectErrorCode, ProjectSummary } from "@quiz/contracts";

import { projectGroupMembers, projectGroups, projects } from "../../db/schema.js";
import {
  accept,
  acceptInvitation,
  auditsOf,
  config,
  groupOf,
  groupProject,
  IN_A_WEEK,
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
import { claimGroupSyncWork, runGroupSyncJob } from "./groupSync.js";
import { projectTick } from "./jobs.js";

useGroupWorld();

const db = () => server.app.db;
const AFTER_DEADLINE = "2026-10-13T00:00:00.000Z";
const at = (iso: string) => server.clock.set(iso);

/** The project's deadline applied by the ticker: its copy stops. */
async function deadlinePassed() {
  at(AFTER_DEADLINE);
  await projectTick(server.app, config);
}

const resync = (projectId: string, confirm?: string) => staff("POST", `/app/api/projects/${projectId}/groups/resync`, confirm === undefined ? {} : { confirm });
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectErrorCode.parse(res.json().error)];

/** The resync asked (`409 needs_confirmation`), then sent again with the digest: 204. The consequences. */
async function confirmResync(projectId: string): Promise<GroupConsequences> {
  const asked = await resync(projectId);
  expect(refusal(asked)).toEqual([409, "needs_confirmation"]);
  const details = GroupConsequences.parse(asked.json());
  const done = await resync(projectId, details.digest);
  expect(done.statusCode, done.body).toBe(204);
  return details;
}

async function sync(projectId: string): Promise<number> {
  const jobs = await claimGroupSyncWork(db(), server.app.clock.now(), projectId);
  for (const job of jobs) await runGroupSyncJob(server.app, config, job);
  return jobs.length;
}

async function placeOf(projectId: string, line: string) {
  const [row] = await db()
    .select({ group: projectGroups.name, departing: projectGroupMembers.departingAt })
    .from(projectGroupMembers)
    .innerJoin(projectGroups, eq(projectGroups.id, projectGroupMembers.groupId))
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, line)));
  return row ? { group: row.group, departing: row.departing !== null } : null;
}

const drifted = async (projectId: string) => ProjectDetail.parse((await staff("GET", `/app/api/projects/${projectId}`)).json()).groupsDrifted;
const projectRow = async (projectId: string) => (await db().select().from(projects).where(eq(projects.id, projectId)))[0]!;

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

describe("Resync with the set after the deadline (ADR-070 §4, §6)", () => {
  it("answers 204 with nothing to resync; names every frozen repository; asks again for a wrong or stale digest", async () => {
    const { project, set, ben, cid, a, b, line } = await twoRepos();
    expect((await resync(project.id)).statusCode).toBe(204);
    await deadlinePassed();
    expect([(await resync(project.id)).statusCode, await drifted(project.id)]).toEqual([204, false]);
    expect(await auditsOf(project.id, "project.group_resync")).toEqual([]);

    // The set moves on; the stopped copy does not.
    await setOk(await moveTo(set, line(ben), groupOf(set, "Group 2").id));
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: false });
    expect(await drifted(project.id)).toBe(true);

    const asked = await resync(project.id);
    expect(refusal(asked)).toEqual([409, "needs_confirmation"]);
    const first = GroupConsequences.parse(asked.json());
    expect(first.consequences.map((c) => [c.enrollmentId, c.groupName, c.repo, c.kind, c.frozen, c.acceptClosed])).toEqual(
      expect.arrayContaining([
        [line(ben), "Group 1", a, "lose", true, false],
        [line(ben), "Group 2", b, "join", true, false],
      ]),
    );
    expect(first.consequences).toHaveLength(2);
    const wrong = await resync(project.id, "0".repeat(64));
    expect([refusal(wrong), wrong.json().digest]).toEqual([[409, "needs_confirmation"], first.digest]);

    // Another write of the set meanwhile: the digest is stale, the resync named again whole.
    await setOk(await moveTo(set, line(cid), null));
    const stale = await resync(project.id, first.digest);
    expect(refusal(stale)).toEqual([409, "needs_confirmation"]);
    const fresh = GroupConsequences.parse(stale.json());
    expect(fresh.digest).not.toBe(first.digest);
    expect(fresh.consequences.map((c) => [c.enrollmentId, c.kind])).toContainEqual([line(cid), "lose"]);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: false });
    expect((await resync(project.id, fresh.digest)).statusCode).toBe(204);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 1", departing: true });
    expect(await drifted(project.id)).toBe(false);
  });

  it("moves a frozen A→B student (moved, never left), audited via group.resync; the copy stays stopped", async () => {
    const { project, set, ben, a, b, line } = await twoRepos();
    await deadlinePassed();
    await setOk(await moveTo(set, line(ben), groupOf(set, "Group 2").id));
    const details = await confirmResync(project.id);
    expect((await projectRow(project.id)).groupResync).toHaveLength(2);

    expect(await sync(project.id)).toBe(1);
    expect(await placeOf(project.id, line(ben))).toEqual({ group: "Group 2", departing: false });
    expect(seats(a)[ben.login]).toBeUndefined();
    expect(pendingInvitations(b)).toContain(ben.login);
    const [ra, rb] = [(await repoRows(project.id)).find((r) => r.fullName === a)!, (await repoRows(project.id)).find((r) => r.fullName === b)!];
    expect((await auditsOf(ra.id, "project_group.repo_revoke")).map((e) => (e.payload as { via: string }).via)).toEqual(["group.resync"]);
    expect((await auditsOf(rb.id, "project_group.repo_invite")).map((e) => (e.payload as { via: string }).via)).toContain("group.resync");
    const [audited] = await auditsOf(project.id, "project.group_resync");
    expect(audited!.payload).toMatchObject({ digest: details.digest, consequences: 2, frozenRepos: [a, b].sort(), deferred: 2 });

    const row = await projectRow(project.id);
    expect([row.groupResync, row.groupSyncDueAt, row.groupsStoppedAt !== null]).toEqual([[], null, true]);
    const stopped = await db().select({ stoppedAt: projectGroups.stoppedAt }).from(projectGroups).where(eq(projectGroups.projectId, project.id));
    expect(stopped.every((g) => g.stoppedAt !== null)).toBe(true);
    expect(await drifted(project.id)).toBe(false);
  });

  it("never applies a set's write made after the confirmation; it is a drift again", async () => {
    const { project, set, ana, ben, a, line } = await twoRepos();
    await deadlinePassed();
    await setOk(await moveTo(set, line(ben), groupOf(set, "Group 2").id));
    await confirmResync(project.id);
    await setOk(await moveTo(set, line(ana), groupOf(set, "Group 2").id));
    await sync(project.id);
    expect(await placeOf(project.id, line(ben))).toMatchObject({ group: "Group 2" });
    expect(await placeOf(project.id, line(ana))).toEqual({ group: "Group 1", departing: false });
    expect(seats(a)[ana.login]).toBe("push");
    expect((await projectRow(project.id)).groupResync).toEqual([]);
    expect(await drifted(project.id)).toBe(true);
  });

  it("keeps a frozen group with a repository whose set group was deleted; its members follow the set (R1)", async () => {
    const { project, set, ana, ben, a, line } = await twoRepos();
    await deadlinePassed();
    await setOk(await moveTo(set, line(ben), groupOf(set, "Group 2").id));
    await setOk(await staff("DELETE", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 1").id}`));
    const details = await confirmResync(project.id);
    expect(details.consequences.map((c) => [c.enrollmentId, c.groupName, c.kind]).sort()).toEqual(
      [
        [line(ana), "Group 1", "lose"],
        [line(ben), "Group 1", "lose"],
        [line(ben), "Group 2", "join"],
      ].sort(),
    );
    await sync(project.id);
    const groups = await db().select().from(projectGroups).where(eq(projectGroups.projectId, project.id));
    expect(groups.map((g) => g.name).sort()).toEqual(["Group 1", "Group 2"]);
    expect(await placeOf(project.id, line(ana))).toBeNull();
    expect(await placeOf(project.id, line(ben))).toMatchObject({ group: "Group 2" });
    // The repository stays, with no member.
    expect((await repoRows(project.id)).map((r) => r.fullName)).toContain(a);
    expect(seats(a)[ana.login]).toBeUndefined();
  });

  it("refuses the release while a confirmed resync is owed (R2)", async () => {
    const { project, set, ben, a, line } = await twoRepos();
    await deadlinePassed();
    await setOk(await moveTo(set, line(ben), null));
    await confirmResync(project.id);
    world.unrevokable.add(a);
    try {
      await expect(sync(project.id)).rejects.toThrow();
      expect(refusal(await staff("POST", `/app/api/projects/${project.id}/release`))).toEqual([409, "group_sync_pending"]);
    } finally {
      world.unrevokable.delete(a);
    }
    at("2026-10-13T01:00:00.000Z");
    await sync(project.id);
    expect(await placeOf(project.id, line(ben))).toBeNull();
    // Owed no more: released.
    const released = await staff("POST", `/app/api/projects/${project.id}/release`);
    expect(released.statusCode, released.body).toBe(200);
  });

  it("flags each arrival into a group without a repository once Accept is closed (R3), one the resync creates included", async () => {
    const [ana, ben, dan] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, dan!], [[0, 1], [2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const a = `${room.login}/lab-1-group-1`;
    const line = (s: Student) => room.lines.get(s.id)!;
    await deadlinePassed();
    let s = await setOk(await staff("POST", `/app/api/group-sets/${set.set.id}/groups`, { name: "Group 3" }));
    s = await setOk(await moveTo(s, line(dan!), groupOf(s, "Group 3").id));
    s = await setOk(await moveTo(s, line(ana!), groupOf(s, "Group 2").id));
    s = await setOk(await moveTo(s, line(ben!), groupOf(s, "Group 3").id));

    const details = await confirmResync(project.id);
    expect(details.consequences.map((c) => [c.enrollmentId, c.groupName, c.repo, c.kind, c.frozen, c.acceptClosed]).sort()).toEqual(
      [
        [line(ana!), "Group 1", a, "lose", true, false],
        [line(ana!), "Group 2", null, "join", true, true],
        [line(ben!), "Group 1", a, "lose", true, false],
        [line(ben!), "Group 3", null, "join", false, true],
        [line(dan!), "Group 3", null, "join", false, true],
      ].sort(),
    );
    // The part without a repository is applied at once: Group 3 made, Dan in it.
    expect(await placeOf(project.id, line(dan!))).toEqual({ group: "Group 3", departing: false });
    expect(await placeOf(project.id, line(ana!))).toEqual({ group: "Group 1", departing: true });
    await sync(project.id);
    expect(await placeOf(project.id, line(ana!))).toEqual({ group: "Group 2", departing: false });
    expect(await placeOf(project.id, line(ben!))).toEqual({ group: "Group 3", departing: false });
    expect([seats(a)[ana!.login], seats(a)[ben!.login]]).toEqual([undefined, undefined]);
    expect((await projectRow(project.id)).groupResync).toEqual([]);
  });
});

describe("Resync with the set on a following project, and its refusals", () => {
  it("resyncs a group its repository's deadline stopped while the project follows", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0], [1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    expect((await staff("PUT", `/app/api/projects/${project.id}/repos/${row!.id}/deadline`, { deadlineAt: "2026-10-05T09:00:00.000Z" })).statusCode).toBe(200);
    at("2026-10-05T10:00:00.000Z");
    await projectTick(server.app, config);
    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 1").id}`, { name: "Renamed" }));
    // Into the stopped group: held, the copy drifts.
    await setOk(await moveTo(set, room.lines.get(ben!.id)!, groupOf(set, "Group 1").id));
    expect(await placeOf(project.id, room.lines.get(ben!.id)!)).toMatchObject({ group: "Group 2" });
    expect(await drifted(project.id)).toBe(true);

    const details = await confirmResync(project.id);
    expect(details.consequences.map((c) => [c.groupName, c.repo, c.kind, c.frozen])).toEqual([["Group 1", row!.fullName, "join", true]]);
    // The rename applied at once, the frozen group's slug and repository unchanged.
    const [g1] = await db().select().from(projectGroups).where(and(eq(projectGroups.projectId, project.id), eq(projectGroups.slug, "group-1")));
    expect([g1!.name, g1!.stoppedAt !== null]).toEqual(["Renamed", true]);
    await sync(project.id);
    expect(await placeOf(project.id, room.lines.get(ben!.id)!)).toEqual({ group: "Renamed", departing: false });
    expect(pendingInvitations(row!.fullName!)).toContain(ben!.login);
    expect((await projectRow(project.id)).groupsStoppedAt).toBeNull();
    expect(await drifted(project.id)).toBe(false);
  });

  it("keeps a resync's departure marked when its group's repository deadline applies before the job", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, cid!], [[0, 1], [2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    expect((await accept(project.id, cid!)).statusCode).toBe(200);
    const [a, b] = [`${room.login}/lab-1-group-1`, `${room.login}/lab-1-group-2`];
    const rows = await repoRows(project.id);
    const own = (fullName: string, deadlineAt: string) =>
      staff("PUT", `/app/api/projects/${project.id}/repos/${rows.find((r) => r.fullName === fullName)!.id}/deadline`, { deadlineAt });
    expect((await own(b, "2026-10-05T09:00:00.000Z")).statusCode).toBe(200);
    expect((await own(a, "2026-10-05T11:00:00.000Z")).statusCode).toBe(200);
    at("2026-10-05T10:00:00.000Z");
    await projectTick(server.app, config);
    const ben_ = room.lines.get(ben!.id)!;
    await setOk(await moveTo(set, ben_, groupOf(set, "Group 2").id));
    await confirmResync(project.id);
    expect(await placeOf(project.id, ben_)).toEqual({ group: "Group 1", departing: true });

    // Group 1's own deadline applies: the stop keeps the resync's mark.
    at("2026-10-05T12:00:00.000Z");
    await projectTick(server.app, config);
    const [g1] = await db().select().from(projectGroups).where(and(eq(projectGroups.projectId, project.id), eq(projectGroups.name, "Group 1")));
    expect(g1!.stoppedAt).not.toBeNull();
    expect(await placeOf(project.id, ben_)).toEqual({ group: "Group 1", departing: true });
    await sync(project.id);
    expect(await placeOf(project.id, ben_)).toEqual({ group: "Group 2", departing: false });
    expect(seats(a)[ben!.login]).toBeUndefined();
    expect(pendingInvitations(b)).toContain(ben!.login);
  });

  it("refuses a draft, an archived project and a released one", async () => {
    const [ana] = [await newStudent()];
    const { project, room, set } = await groupProject([ana!], [[0]]);
    const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, {
      name: "Lab 2",
      sourceRepo: "starter",
      deadlineAt: IN_A_WEEK,
      groupMode: true,
      groupSetId: set.set.id,
    });
    const draft = ProjectSummary.parse(created.json());
    expect(refusal(await resync(draft.id))).toEqual([409, "not_draft"]);
    expect(await drifted(draft.id)).toBe(false);

    await db().update(projects).set({ releasedAt: new Date(NOW) }).where(eq(projects.id, project.id));
    expect(refusal(await resync(project.id))).toEqual([409, "released"]);
    expect((await staff("POST", `/app/api/projects/${project.id}/archive`)).statusCode).toBe(200);
    expect(refusal(await resync(project.id))).toEqual([409, "project_archived"]);
  });

  it("refuses a roster removal while the resync's revocation is under way and GitHub refuses it (502)", async () => {
    const { project, room, set, ben, a, line } = await twoRepos();
    await deadlinePassed();
    await setOk(await moveTo(set, line(ben), null));
    await confirmResync(project.id);
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
  });
});
