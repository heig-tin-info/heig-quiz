/**
 * Group repositories and the accounts let into them (ADR-048 lot 2,
 * ADR-070 §4–§5, F-PROJ-05/06/17, N-SEC-20; merge task M3-15b-1), ported
 * from heig-classroom's `group-repos.db.test.ts` where its rules survive, on
 * a server built with Quiz's App against the fake GitHub and the local bare
 * repositories (`./testing.ts`):
 *
 * - Accept: the first member makes `<slug>-<group>` and every linked member
 *   is invited, each account recorded; a later member is invited on it; two
 *   at once make one; `no_group`; a name another classroom's row bears,
 *   disambiguated; a student linking later is invited;
 * - whose repository: through the copy, never its creator moved out (no
 *   row, no student view, no hint, no resend);
 * - the set: a step reaching a group with a repository is `409 has_repo`,
 *   nothing written; a rename follows, the slug fixed;
 * - leaving: a removal, an unclaim, an e-mail change, a self-enroll revoke
 *   the RECORDED accounts first (an unlinked and relinked student's too, an
 *   individual repository's too); GitHub refusing is `502 revoke_failed`,
 *   the roster, the set and the copy unchanged; the App gone, a repository
 *   deleted, a student never invited proceed, audited `skipped`.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupErrorCode, GroupSetDetail, ProjectAcceptErrorCode, ProjectDetail, ProjectSummary, RosterErrorCode, StudentProject } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectGroupMembers,
  projectGroups,
  projectRepoAccess,
  projectRepos,
  studentGroupMembers,
  users,
} from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { inviteOnGithubLink } from "./access.js";
import { hintRepo, repoContext } from "./repos.js";
import { repoWorld } from "./testing.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-05T08:00:00.000Z";
const IN_A_WEEK = "2026-10-12T22:00:00.000Z";

type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
interface Student {
  id: string;
  headers: Headers;
  githubUserId: number;
  login: string;
}

let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 61_000;
let nextAccount = 81_000;

/** GitHub's accounts, by immutable id: today's login. Missing: deleted. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

const call = (method: Method, url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
const staff = (method: Method, url: string, payload?: object) => call(method, url, teacher.headers, payload);
const accept = (projectId: string, who: { headers: Headers }) => call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
const acceptRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectAcceptErrorCode.parse(res.json().error)];
const groupRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, GroupErrorCode.parse(res.json().error)];
const rosterRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, RosterErrorCode.parse(res.json().error)];

/** A student with a linked GitHub account (unless `linked: false`). */
async function newStudent(opts: { linked?: boolean } = {}): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `kid${githubUserId}`;
  if (opts.linked !== false) await link(signed.id, githubUserId, login);
  return { ...signed, githubUserId, login };
}

async function link(userId: string, githubUserId: number, login: string) {
  await server.app.db.insert(githubAccounts).values({ userId, githubUserId, login });
  accounts.set(githubUserId, login);
}

interface Org {
  login: string;
  orgId: string;
}

interface Room extends Org {
  id: string;
  /** The roster line of each student, by user id. */
  lines: Map<string, string>;
}

/** A classroom of `teacher`'s course connected to an organization holding `starter` (a new one, unless `org` is given). */
async function connectedClassroom(students: Student[], org?: Org): Promise<Room> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  let at = org;
  if (!at) {
    const n = nextOrg++;
    const login = `gorg-${n}`;
    world.orgIds[login] = n;
    world.source(login, "starter", { main: { "README.md": "# Lab" } });
    const orgId = randomUUID();
    await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
    at = { login, orgId };
  }
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId: at.orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const lines = await db.select().from(enrollments).where(eq(enrollments.classroomId, seeded.classroomId));
  return { id: seeded.classroomId, login: at.login, orgId: at.orgId, lines: new Map(lines.map((l) => [l.userId!, l.id])) };
}

async function setOk(res: { statusCode: number; body: string; json: () => unknown }): Promise<GroupSetDetail> {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return GroupSetDetail.parse(res.json());
}

/**
 * A published group project `Lab 1` of a fresh classroom of `students`,
 * following a set whose groups are `groups` (indexes into `students`),
 * named "Group 1", "Group 2"…
 */
async function groupProject(students: Student[], groups: number[][], org?: Org) {
  const room = await connectedClassroom(students, org);
  let set = await setOk(await staff("POST", `/app/api/classrooms/${room.id}/group-sets`, {}));
  for (const [k, members] of groups.entries()) {
    set = await setOk(await staff("POST", `/app/api/group-sets/${set.set.id}/groups`, { name: `Group ${k + 1}` }));
    const group = set.groups.find((g) => g.name === `Group ${k + 1}`)!;
    for (const i of members) {
      set = await setOk(await staff("PUT", `/app/api/group-sets/${set.set.id}/members/${room.lines.get(students[i]!.id)}`, { groupId: group.id }));
    }
  }
  const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, {
    name: "Lab 1",
    sourceRepo: "starter",
    deadlineAt: IN_A_WEEK,
    groupMode: true,
    groupSetId: set.set.id,
  });
  expect(created.statusCode, created.body).toBe(201);
  const project = ProjectSummary.parse(created.json());
  const published = await staff("POST", `/app/api/projects/${project.id}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  return { project, room, set };
}

const groupOf = (set: GroupSetDetail, name: string) => set.groups.find((g) => g.name === name)!;
const moveTo = (set: GroupSetDetail, line: string, groupId: string | null) =>
  staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line}`, { groupId });
const repoRows = (projectId: string) => server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
const grantsOf = (repoId: string) => server.app.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.repoId, repoId));
const auditsOf = (subjectId: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const seats = (fullName: string) => Object.fromEntries(world.collaborators.get(fullName) ?? []);
const pendingInvitations = (fullName: string) => [...(world.invitations.get(fullName)?.values() ?? [])];
/** The invitation of `login` accepted on GitHub: a collaborator from now on. */
const acceptInvitation = (fullName: string, login: string) => {
  const pending = world.invitations.get(fullName)!;
  for (const [id, who] of pending) if (who === login) pending.delete(id);
};
const removeLine = (room: Room, line: string) => staff("DELETE", `/app/api/classrooms/${room.id}/roster/${line}`);

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- Accept

describe("a group's repository at Accept (ADR-048 lot 2)", () => {
  it("is made by the first member, every linked member invited with push and recorded", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent({ linked: false })];
    const { project, room } = await groupProject([ana!, ben!, cid!], [[0, 1, 2]]);
    const res = await accept(project.id, ana!);
    expect(res.statusCode, res.body).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    expect(res.json()).toEqual({ status: "ok", fullName, invitationStatus: "pending" });
    // Every member with a linked account, `push` and never more; the unlinked one waits for their link.
    expect(seats(fullName)).toEqual({ [ana!.login]: "push", [ben!.login]: "push" });

    const [row] = await repoRows(project.id);
    const [group] = await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, project.id));
    expect(row).toMatchObject({ userId: ana!.id, groupId: group!.id, provisionStatus: "ok", fullName });
    const grants = await grantsOf(row!.id);
    expect(grants.map((g) => [g.enrollmentId, g.githubUserId, g.githubLogin, g.revokedAt]).sort()).toEqual(
      [
        [room.lines.get(ana!.id), ana!.githubUserId, ana!.login, null],
        [room.lines.get(ben!.id), ben!.githubUserId, ben!.login, null],
      ].sort(),
    );
    const invites = await auditsOf(row!.id, "project_group.repo_invite");
    expect(invites.map((a) => a.payload)).toEqual([
      { repo: fullName, enrollmentId: room.lines.get(ben!.id), login: ben!.login, invitation: "pending", via: "accept" },
    ]);
  });

  it("attaches a later member: one row, their own invitation", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    acceptInvitation(fullName, ben!.login);
    const res = await accept(project.id, ben!);
    expect([res.statusCode, res.json()]).toEqual([200, { status: "ok", fullName, invitationStatus: "accepted" }]);
    expect(await repoRows(project.id)).toHaveLength(1);
  });

  it("makes ONE repository for two members accepting at the same second", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    const creations = () => gh.calls.filter((c) => c === `POST api.github.com/orgs/${room.login}/repos`).length;
    const before = creations();
    const answers = await Promise.all([accept(project.id, ana!), accept(project.id, ben!)]);
    for (const res of answers) {
      expect([200, 409], res.body).toContain(res.statusCode);
      if (res.statusCode === 409) expect(acceptRefusal(res)).toEqual([409, "provision_in_progress"]);
    }
    expect(await repoRows(project.id)).toHaveLength(1);
    expect(creations() - before).toBe(1);
  });

  it("refuses a student the copy places in no group (no_group), and their group's repository waits", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0, 1]]);
    // No repository yet: the copy follows the move out at once.
    await setOk(await moveTo(set, room.lines.get(ben!.id)!, null));
    expect(acceptRefusal(await accept(project.id, ben!))).toEqual([409, "no_group"]);
    expect(await repoRows(project.id)).toHaveLength(0);
  });

  it("disambiguates a name another classroom's repository bears, by the group's id", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const first = await groupProject([ana!], [[0]]);
    expect((await accept(first.project.id, ana!)).statusCode).toBe(200);
    const second = await groupProject([ben!], [[0]], first.room);
    const res = await accept(second.project.id, ben!);
    expect(res.statusCode, res.body).toBe(200);
    const [group] = await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, second.project.id));
    expect(res.json().fullName).toBe(`${first.room.login}/lab-1-group-1-${group!.id.slice(0, 8)}`);
  });

  it("invites a member who links GitHub after their group's repository was made", async () => {
    const [ana, cid] = [await newStudent(), await newStudent({ linked: false })];
    const { project, room } = await groupProject([ana!, cid!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    await link(cid!.id, cid!.githubUserId, cid!.login);
    const invited = await inviteOnGithubLink(server.app.db, config, cid!.id, { githubUserId: cid!.githubUserId, login: cid!.login }, {
      now: new Date(NOW),
      log: server.app.log,
    });
    expect(invited).toEqual([fullName]);
    expect(seats(fullName)[cid!.login]).toBe("push");
    const [row] = await repoRows(project.id);
    expect((await grantsOf(row!.id)).some((g) => g.githubLogin === cid!.login && g.revokedAt === null)).toBe(true);
    const invites = await auditsOf(row!.id, "project_group.repo_invite");
    expect(invites.map((a) => [a.actorUserId, (a.payload as { via: string }).via])).toContainEqual([cid!.id, "link"]);
  });
});

// ---------------------------------------------------------------- whose repository

describe("a group's repository is a student's through the copy only (N-SEC-20)", () => {
  it("never its creator moved out: no row, no student view, no hint, no resend", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    const [row] = await repoRows(project.id);

    // Both members read it while both are in.
    for (const who of [ana!, ben!]) {
      const view = StudentProject.parse((await call("GET", `/app/api/student/projects/${project.id}`, who.headers)).json());
      expect(view.repo?.fullName).toBe(fullName);
    }

    // The creator leaves the group (the copy's own fact; the set cannot do it while the repository exists).
    await server.app.db.delete(projectGroupMembers).where(eq(projectGroupMembers.enrollmentId, room.lines.get(ana!.id)!));

    const mine = StudentProject.parse((await call("GET", `/app/api/student/projects/${project.id}`, ana!.headers)).json());
    expect(mine.repo).toBeNull();
    // The home's cards: the same rule.
    expect((await call("GET", "/app/api/student/home", ana!.headers)).body).not.toContain("lab-1-group-1");
    expect((await call("GET", "/app/api/student/home", ben!.headers)).body).toContain(fullName);
    const theirs = StudentProject.parse((await call("GET", `/app/api/student/projects/${project.id}`, ben!.headers)).json());
    expect(theirs.repo?.fullName).toBe(fullName);

    const detail = ProjectDetail.parse((await staff("GET", `/app/api/projects/${project.id}`)).json());
    const rowOf = (userId: string) => detail.rows.find((r) => r.student.userId === userId && r.student.enrollmentId !== null)!;
    expect(rowOf(ana!.id).repo).toBeNull();
    expect(rowOf(ben!.id).repo?.provisionStatus).toBe("ok");

    const topics: string[] = [];
    const off = subscribe((e) => {
      if (e.kind === "hint") topics.push(...e.topics);
    });
    await hintRepo(server.app.db, (await repoContext(server.app.db, row!.githubRepoId!))!);
    off();
    expect(topics).toContain(`user:${ben!.id}`);
    expect(topics).not.toContain(`user:${ana!.id}`);

    // Their own resend: no repository of theirs. The staff's: the members only.
    const own = await call("POST", `/app/api/student/projects/${project.id}/invite`, ana!.headers);
    expect([own.statusCode, own.json().error]).toEqual([409, "repo_unavailable"]);
    world.collaborators.get(fullName)!.delete(ana!.login);
    world.collaborators.get(fullName)!.delete(ben!.login);
    world.invitations.get(fullName)!.clear();
    const resent = await staff("POST", `/app/api/projects/${project.id}/repos/${row!.id}/invite`);
    expect(resent.statusCode, resent.body).toBe(200);
    expect(seats(fullName)).toEqual({ [ben!.login]: "push" });
  });

  it("a member's own resend invites them alone", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    world.collaborators.get(fullName)!.clear();
    world.invitations.get(fullName)!.clear();
    const res = await call("POST", `/app/api/student/projects/${project.id}/invite`, ben!.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(seats(fullName)).toEqual({ [ben!.login]: "push" });
  });
});

// ---------------------------------------------------------------- the set

describe("a set's write that would reach a group with a repository (until M3-15b-2)", () => {
  it("is refused whole, 409 has_repo: a member out, a member in, the group deleted", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, cid!], [[0, 1], [2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [g1, g2] = [groupOf(set, "Group 1"), groupOf(set, "Group 2")];
    const copyBefore = await server.app.db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id));
    const setBefore = await server.app.db.select().from(studentGroupMembers).where(eq(studentGroupMembers.setId, set.set.id));

    const out = await moveTo(set, room.lines.get(ben!.id)!, g2.id);
    expect(groupRefusal(out)).toEqual([409, "has_repo"]);
    expect(out.json().projects).toEqual([{ id: project.id, name: "Lab 1" }]);
    expect(groupRefusal(await moveTo(set, room.lines.get(cid!.id)!, g1.id))).toEqual([409, "has_repo"]);
    expect(groupRefusal(await moveTo(set, room.lines.get(ana!.id)!, null))).toEqual([409, "has_repo"]);
    expect(groupRefusal(await staff("DELETE", `/app/api/group-sets/${set.set.id}/groups/${g1.id}`))).toEqual([409, "has_repo"]);

    expect(await server.app.db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id))).toEqual(copyBefore);
    expect(await server.app.db.select().from(studentGroupMembers).where(eq(studentGroupMembers.setId, set.set.id))).toEqual(setBefore);

    // A group with no repository still follows: Group 2 deleted, its student in no group.
    await setOk(await staff("DELETE", `/app/api/group-sets/${set.set.id}/groups/${g2.id}`));
    expect(await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, project.id))).toHaveLength(1);
  });

  it("follows a rename, the repository's slug fixed and kept from any other group", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, set } = await groupProject([ana!, ben!], [[0], [1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 1").id}`, { name: "Les Pandas" }));
    await setOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}/groups/${groupOf(set, "Group 2").id}`, { name: "Group 1" }));
    const copy = await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, project.id)).orderBy(projectGroups.position);
    expect(copy.map((g) => [g.name, g.slug])).toEqual([
      ["Les Pandas", "group-1"],
      ["Group 1", "group-1-2"],
    ]);
  });
});

// ---------------------------------------------------------------- leaving

describe("leaving the roster, or an account, revokes the recorded accounts first (F-PROJ-17)", () => {
  it("removes a member: the seat and a pending invitation taken, audited, then the line", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    acceptInvitation(fullName, ana!.login);
    const [row] = await repoRows(project.id);

    const res = await removeLine(room, room.lines.get(ana!.id)!);
    expect(res.statusCode, res.body).toBe(204);
    expect(seats(fullName)).toEqual({ [ben!.login]: "push" });
    const res2 = await removeLine(room, room.lines.get(ben!.id)!);
    expect(res2.statusCode, res2.body).toBe(204);
    expect(seats(fullName)).toEqual({});
    expect(pendingInvitations(fullName)).toEqual([]);
    // The lines gone, their grants with them; the audit keeps the trace.
    expect(await grantsOf(row!.id)).toEqual([]);
    const revokes = await auditsOf(row!.id, "project_group.repo_revoke");
    expect(revokes.map((a) => a.payload)).toEqual([
      { repo: fullName, enrollmentId: room.lines.get(ana!.id), login: ana!.login, via: "roster.remove", outcome: "ok", invitationsCancelled: 0 },
      { repo: fullName, enrollmentId: room.lines.get(ben!.id), login: ben!.login, via: "roster.remove", outcome: "ok", invitationsCancelled: 1 },
    ]);
  });

  it("refuses with 502 revoke_failed when GitHub refuses: roster, set and copy unchanged", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    acceptInvitation(fullName, ben!.login);
    world.unrevokable.add(fullName);
    try {
      const line = room.lines.get(ben!.id)!;
      const res = await removeLine(room, line);
      expect(rosterRefusal(res)).toEqual([502, "revoke_failed"]);
      expect(await server.app.db.select().from(enrollments).where(eq(enrollments.id, line))).toHaveLength(1);
      expect(await server.app.db.select().from(studentGroupMembers).where(eq(studentGroupMembers.setId, set.set.id))).toHaveLength(2);
      expect(await server.app.db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id))).toHaveLength(2);
      expect(seats(fullName)[ben!.login]).toBe("push");
      // The unclaim and the e-mail change refuse alike.
      expect(rosterRefusal(await staff("POST", `/app/api/classrooms/${room.id}/roster/${line}/unclaim`))).toEqual([502, "revoke_failed"]);
      const patched = await staff("PATCH", `/app/api/classrooms/${room.id}/roster/${line}`, { email: "elsewhere@heig.test" });
      expect(rosterRefusal(patched)).toEqual([502, "revoke_failed"]);
      const [kept] = await server.app.db.select().from(enrollments).where(eq(enrollments.id, line));
      expect([kept!.userId, kept!.email === "elsewhere@heig.test"]).toEqual([ben!.id, false]);
    } finally {
      world.unrevokable.delete(fullName);
    }
    // Retried once GitHub takes it: done.
    expect((await removeLine(room, room.lines.get(ben!.id)!)).statusCode).toBe(204);
    expect(seats(fullName)[ben!.login]).toBeUndefined();
  });

  it("proceeds when there is nothing to take, audited skipped: the App gone, a repository deleted, a student never invited", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent({ linked: false })];
    const { project, room } = await groupProject([ana!, ben!, cid!], [[0, 1, 2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const reasons = async () => (await auditsOf(row!.id, "project_group.repo_revoke")).map((a) => (a.payload as { reason?: string }).reason);

    expect((await removeLine(room, room.lines.get(cid!.id)!)).statusCode).toBe(204);
    expect(await reasons()).toEqual(["not_invited"]);

    await server.app.db.update(projectRepos).set({ deletedAt: new Date(NOW) }).where(eq(projectRepos.id, row!.id));
    expect((await removeLine(room, room.lines.get(ben!.id)!)).statusCode).toBe(204);
    expect(await reasons()).toEqual(["not_invited", "repo_deleted"]);

    await server.app.db.update(projectRepos).set({ deletedAt: null }).where(eq(projectRepos.id, row!.id));
    await server.app.db.update(githubOrganizations).set({ installationId: null }).where(eq(githubOrganizations.id, room.orgId));
    expect((await removeLine(room, room.lines.get(ana!.id)!)).statusCode).toBe(204);
    expect(await reasons()).toEqual(["not_invited", "repo_deleted", "app_not_installed"]);
  });

  it("revokes the account invited, not the one linked since", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    acceptInvitation(fullName, ben!.login);
    // Ben unlinks, and links another account, which nobody invited.
    await server.app.db.delete(githubAccounts).where(eq(githubAccounts.userId, ben!.id));
    await link(ben!.id, nextAccount++, "ben-new");
    world.collaborators.get(fullName)!.set("ben-new", "push");
    expect((await removeLine(room, room.lines.get(ben!.id)!)).statusCode).toBe(204);
    expect(seats(fullName)[ben!.login]).toBeUndefined();
    expect(seats(fullName)["ben-new"]).toBe("push");
  });

  it("an unclaim and an e-mail change revoke the line's account, the line stays", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!, cid!], [[0, 1, 2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    const [row] = await repoRows(project.id);

    const unclaimed = await staff("POST", `/app/api/classrooms/${room.id}/roster/${room.lines.get(ben!.id)}/unclaim`);
    expect(unclaimed.statusCode, unclaimed.body).toBe(200);
    expect(seats(fullName)[ben!.login]).toBeUndefined();
    const patched = await staff("PATCH", `/app/api/classrooms/${room.id}/roster/${room.lines.get(cid!.id)}`, { email: `moved-${randomUUID()}@heig.test` });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(seats(fullName)[cid!.login]).toBeUndefined();
    const live = (await grantsOf(row!.id)).filter((g) => g.revokedAt === null).map((g) => g.githubLogin);
    expect(live).toEqual([ana!.login]);
    const vias = (await auditsOf(row!.id, "project_group.repo_revoke")).map((a) => (a.payload as { via: string }).via);
    expect(vias).toEqual(["roster.unclaim", "roster.update"]);
  });

  it("a self-enroll turning a member's line into a staff seat revokes it, and the set's next write is not held", async () => {
    const [ana, ben, cid] = [await newStudent(), await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!, cid!], [[0, 1], [2]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    // Ben's line holds the teacher's address (a teacher placed under their own address).
    const [me] = await server.app.db.select().from(users).where(eq(users.id, teacher.id));
    await server.app.db.update(enrollments).set({ email: me!.email }).where(eq(enrollments.id, room.lines.get(ben!.id)!));
    const res = await staff("POST", `/app/api/classrooms/${room.id}/self-enroll`);
    expect(res.statusCode, res.body).toBe(201);
    expect(seats(fullName)[ben!.login]).toBeUndefined();
    // The staff seat leaves the copy with the next write, which reaches no student of the repository.
    await setOk(await staff("POST", `/app/api/group-sets/${set.set.id}/groups`, { name: "Group 3" }));
    const copy = await server.app.db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id));
    expect(copy.map((m) => m.enrollmentId).sort()).toEqual([room.lines.get(ana!.id), room.lines.get(cid!.id)].sort());
  });

  it("revokes a student's own repository too (an individual project)", async () => {
    const ana = await newStudent();
    const room = await connectedClassroom([ana]);
    const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, { name: "Solo", sourceRepo: "starter", deadlineAt: IN_A_WEEK });
    const project = ProjectSummary.parse(created.json());
    expect((await staff("POST", `/app/api/projects/${project.id}/publish`)).statusCode).toBe(200);
    expect((await accept(project.id, ana)).statusCode).toBe(200);
    const fullName = `${room.login}/solo-${ana.login}`;
    const [row] = await repoRows(project.id);
    expect((await grantsOf(row!.id)).map((g) => g.githubLogin)).toEqual([ana.login]);
    expect((await removeLine(room, room.lines.get(ana.id)!)).statusCode).toBe(204);
    expect(seats(fullName)).toEqual({});
    expect(pendingInvitations(fullName)).toEqual([]);
  });
});
