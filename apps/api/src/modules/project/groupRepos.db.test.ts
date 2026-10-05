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
 *   individual repository's too, its invitation state cleared); GitHub
 *   refusing is `502 revoke_failed`, the roster, the set and the copy
 *   unchanged; the App gone (or its installation gone on GitHub), a
 *   repository deleted, a student never invited proceed, audited `skipped`;
 * - the races, interleaved through the fake GitHub: a line removed before
 *   its invitation is recorded (never invited), or while GitHub is asked
 *   (the invitation taken back); an account recorded during a removal, an
 *   unclaim or a self-enroll (`502`, retried); a removal during the first
 *   provisioning (`502`, retried); a set's move during it (`has_repo`); a
 *   student moved out of their group during their Accept (`no_group`); a
 *   classroom deleted with its grants; the backfill of 0067.
 */
import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupErrorCode, GroupSetDetail, ProjectAcceptErrorCode, ProjectDetail, ProjectSummary, RosterErrorCode, StudentProject } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
  projectGroupMembers,
  projectGroups,
  projectRepoAccess,
  projectRepos,
  projects,
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

/**
 * Hooks a matching GitHub call runs first (each once), before the call goes
 * on to the world, and `after` once it landed: how a test interleaves a
 * request with another's.
 */
interface Hook {
  match: (url: URL, method: string) => boolean;
  run: () => Promise<void>;
  after?: () => void;
}
let hooks: Hook[] = [];
const on = (h: Hook) => void hooks.push(h);
const hookRoute: Route = (url, req) => {
  const at = hooks.findIndex((h) => h.match(url, req.method));
  if (at < 0) return undefined;
  const [h] = hooks.splice(at, 1);
  return (async () => {
    await h!.run();
    const res = world.route(url, req) ?? usersRoute(url, req) ?? json({ message: "Not Found" }, 404);
    h!.after?.();
    return res;
  })() as unknown as Response;
};
/** Installations whose token GitHub refuses (gone without a webhook). */
const goneInstallations = new Set<number>();
const tokensRoute: Route = (url, req) => {
  const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  return req.method === "POST" && m && goneInstallations.has(Number(m[1])) ? json({ message: "Not Found" }, 404) : undefined;
};

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [hookRoute, tokensRoute, orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  hooks = [];
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

  it("tells a member of their invitation once: at the first Accept that invited them, never at their own clicks (F-NOTIF-13)", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project } = await groupProject([ana!, ben!], [[0, 1]]);
    const invitedBells = async (userId: string) =>
      (await server.app.db.select({ payload: notifications.payload }).from(notifications).where(eq(notifications.userId, userId))).filter(
        (r) => (r.payload as { kind: string; projectId?: string }).kind === "project_repo_invited" && (r.payload as { projectId?: string }).projectId === project.id,
      );
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    // Ana made the repository and is invited; Ben was invited by her Accept.
    expect(await invitedBells(ana!.id)).toHaveLength(1);
    expect(await invitedBells(ben!.id)).toHaveLength(1);
    // Ben's own Accept re-invites him (GitHub answers pending again): told no second time, nor on a repeat.
    for (let i = 0; i < 2; i++) {
      const res = await accept(project.id, ben!);
      expect([res.statusCode, res.json().invitationStatus]).toEqual([200, "pending"]);
    }
    expect(await invitedBells(ben!.id)).toHaveLength(1);
    expect(await invitedBells(ana!.id)).toHaveLength(1);
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
    await inviteOnGithubLink(server.app.db, config, cid!.id, { now: new Date(NOW), log: server.app.log });
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
    // Both invitations still pending: only the member's is sent again.
    const before = gh.calls.length;
    const resent = await staff("POST", `/app/api/projects/${project.id}/repos/${row!.id}/invite`);
    expect(resent.statusCode, resent.body).toBe(200);
    expect(gh.calls.slice(before).filter((c) => c.startsWith("PUT"))).toEqual([`PUT api.github.com/repos/${fullName}/collaborators/${ben!.login}`]);
  });

  it("the staff's resend of a group's re-invites the members still out only", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    acceptInvitation(fullName, ana!.login);
    const [row] = await repoRows(project.id);
    const before = gh.calls.length;
    const res = await staff("POST", `/app/api/projects/${project.id}/repos/${row!.id}/invite`);
    expect(res.statusCode, res.body).toBe(200);
    expect(gh.calls.slice(before).filter((c) => c.startsWith("PUT"))).toEqual([`PUT api.github.com/repos/${fullName}/collaborators/${ben!.login}`]);
    const [entry] = await auditsOf(row!.id, "project_repo.invite_resent");
    // Ben is still out: GitHub answers his invitation again, pending (the fake follows GitHub here).
    expect(entry!.payload).toEqual({ logins: [ben!.login], invitationStatus: "pending" });
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
    const before = gh.calls.length;
    const res2 = await removeLine(room, room.lines.get(ben!.id)!);
    expect(res2.statusCode, res2.body).toBe(204);
    // The pending invitation cancelled BEFORE the seat is removed: it cannot be accepted in between.
    const deletes = gh.calls.slice(before).filter((c) => c.startsWith("DELETE"));
    expect(deletes.map((c) => c.split("/")[4])).toEqual(["invitations", "collaborators"]);
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
    // Nobody is let in any more: its invitation state says so.
    expect((await repoRows(project.id))[0]!.invitationStatus).toBe("none");
  });

  it("refuses the staff's resend of an individual repository with no student on the roster (repo_unavailable)", async () => {
    const ana = await newStudent();
    const room = await connectedClassroom([ana]);
    const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, { name: "Alone", sourceRepo: "starter", deadlineAt: IN_A_WEEK });
    const project = ProjectSummary.parse(created.json());
    expect((await staff("POST", `/app/api/projects/${project.id}/publish`)).statusCode).toBe(200);
    expect((await accept(project.id, ana)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    // A student whose account was never recorded (unlinked before 0067's backfill) leaves: nothing to take.
    await server.app.db.delete(projectRepoAccess).where(eq(projectRepoAccess.repoId, row!.id));
    expect((await removeLine(room, room.lines.get(ana.id)!)).statusCode).toBe(204);
    const res = await staff("POST", `/app/api/projects/${project.id}/repos/${row!.id}/invite`);
    expect([res.statusCode, res.json().error]).toEqual([409, "repo_unavailable"]);
  });

  it("skips an installation GitHub no longer knows (its token refused) as app_not_installed", async () => {
    const [ana] = [await newStudent()];
    const { project, room } = await groupProject([ana!], [[0]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const gone = nextOrg++;
    goneInstallations.add(gone);
    await server.app.db.update(githubOrganizations).set({ installationId: gone }).where(eq(githubOrganizations.id, room.orgId));
    expect((await removeLine(room, room.lines.get(ana!.id)!)).statusCode).toBe(204);
    const [revoke] = await auditsOf(row!.id, "project_group.repo_revoke");
    expect(revoke!.payload).toMatchObject({ outcome: "skipped", reason: "app_not_installed" });
  });
});

// ---------------------------------------------------------------- the races

describe("the races of an invitation and a departure (R1–R3)", () => {
  it("never invites a line removed before its account is recorded", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    const line = room.lines.get(ben!.id)!;
    // Ben's line goes while Ana's Accept asks GitHub for Ben's login.
    on({
      match: (url, method) => method === "GET" && url.pathname === `/user/${ben!.githubUserId}`,
      run: async () => void (await removeLine(room, line)),
    });
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const fullName = `${room.login}/lab-1-group-1`;
    expect(seats(fullName)).toEqual({ [ana!.login]: "push" });
    expect(await server.app.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, line))).toEqual([]);
  });

  it("takes an invitation back when the line was removed while GitHub was asked", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    const line = room.lines.get(ben!.id)!;
    const fullName = `${room.login}/lab-1-group-1`;
    // Ben's grant is recorded; his removal runs before GitHub's answer to his invitation.
    on({
      match: (url, method) => method === "PUT" && url.pathname.endsWith(`/collaborators/${ben!.login}`),
      run: async () => {
        const res = await removeLine(room, line);
        expect(res.statusCode, res.body).toBe(204);
      },
    });
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    expect(await server.app.db.select().from(enrollments).where(eq(enrollments.id, line))).toEqual([]);
    expect(seats(fullName)).toEqual({ [ana!.login]: "push" });
    expect(pendingInvitations(fullName)).toEqual([ana!.login]);
  });

  /** Ben's line gets another account recorded while `write` revokes his: `502`, then the retry passes. */
  const recordedMeanwhile = async (write: (room: Room, line: string) => Promise<{ statusCode: number; body: string; json: () => { error: unknown } }>) => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    const line = room.lines.get(ben!.id)!;
    const other = nextAccount++;
    accounts.set(other, `ben-other-${other}`);
    on({
      match: (url, method) => method === "GET" && url.pathname === `/user/${ben!.githubUserId}`,
      run: async () =>
        void (await server.app.db
          .insert(projectRepoAccess)
          .values({ id: randomUUID(), repoId: row!.id, enrollmentId: line, githubUserId: other, githubLogin: `ben-other-${other}`, invitedAt: new Date(NOW) })),
    });
    expect(rosterRefusal(await write(room, line))).toEqual([502, "revoke_failed"]);
    const [kept] = await server.app.db.select().from(enrollments).where(eq(enrollments.id, line));
    expect([kept?.userId, kept?.staff]).toEqual([ben!.id, false]);
    const retried = await write(room, line);
    expect(retried.statusCode, retried.body).toBeLessThan(300);
    const logins = (await auditsOf(row!.id, "project_group.repo_revoke")).map((a) => (a.payload as { login: string }).login);
    expect(logins).toEqual([ben!.login, `ben-other-${other}`]);
  };

  it("refuses a removal whose line got an account recorded meanwhile (502), then takes it on retry", async () => {
    await recordedMeanwhile((room, line) => removeLine(room, line));
  });

  it("refuses an unclaim whose line got an account recorded meanwhile (502), then takes it on retry", async () => {
    await recordedMeanwhile((room, line) => staff("POST", `/app/api/classrooms/${room.id}/roster/${line}/unclaim`));
  });

  it("refuses a self-enroll whose line got an account recorded meanwhile (502), then takes it on retry", async () => {
    const [me] = await server.app.db.select().from(users).where(eq(users.id, teacher.id));
    await recordedMeanwhile(async (room, line) => {
      await server.app.db.update(enrollments).set({ email: me!.email }).where(eq(enrollments.id, line));
      return staff("POST", `/app/api/classrooms/${room.id}/self-enroll`);
    });
  });

  it("refuses a removal while the group's first provisioning runs (502), then revokes once it is done", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    const fullName = `${room.login}/lab-1-group-1`;
    let during: { statusCode: number; json: () => { error: unknown } } | undefined;
    on({
      match: (url, method) => method === "POST" && url.pathname === `/orgs/${room.login}/repos`,
      run: async () => void (during = await removeLine(room, room.lines.get(ana!.id)!)),
    });
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    expect(rosterRefusal(during!)).toEqual([502, "revoke_failed"]);
    expect(seats(fullName)[ana!.login]).toBe("push");
    expect((await removeLine(room, room.lines.get(ana!.id)!)).statusCode).toBe(204);
    expect(seats(fullName)[ana!.login]).toBeUndefined();
  });

  it("refuses a set's move out of a group whose first provisioning runs (has_repo)", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0, 1]]);
    let during: { statusCode: number; json: () => { error: unknown } } | undefined;
    on({
      match: (url, method) => method === "POST" && url.pathname === `/orgs/${room.login}/repos`,
      run: async () => void (during = await moveTo(set, room.lines.get(ben!.id)!, null)),
    });
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    expect(groupRefusal(during!)).toEqual([409, "has_repo"]);
    expect(seats(`${room.login}/lab-1-group-1`)[ben!.login]).toBe("push");
  });

  it("answers no_group to a student moved out of their group during their Accept, nothing made", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room, set } = await groupProject([ana!, ben!], [[0, 1]]);
    on({
      match: (url, method) => method === "GET" && url.pathname === `/user/${ana!.githubUserId}`,
      run: async () => void (await setOk(await moveTo(set, room.lines.get(ana!.id)!, null))),
    });
    expect(acceptRefusal(await accept(project.id, ana!))).toEqual([409, "no_group"]);
    expect(await repoRows(project.id)).toEqual([]);
  });

  it("takes back an invitation landing between a revocation's listing of invitations and its seat's removal", async () => {
    const [ana, ben] = [await newStudent(), await newStudent()];
    const { project, room } = await groupProject([ana!, ben!], [[0, 1]]);
    const fullName = `${room.login}/lab-1-group-1`;
    const line = room.lines.get(ben!.id)!;
    let removal: Promise<{ statusCode: number; body: string }> | undefined;
    let listed!: () => void;
    let landed!: () => void;
    const invitationsListed = new Promise<void>((resolve) => (listed = resolve));
    const putLanded = new Promise<void>((resolve) => (landed = resolve));
    // Ana's Accept invites Ben: his removal starts, lists the invitations
    // (none of his yet), then his invitation lands, then the removal takes
    // his seat away (a pending invitation is no seat: nothing removed).
    on({
      match: (url, method) => method === "PUT" && url.pathname.endsWith(`/collaborators/${ben!.login}`),
      run: async () => {
        removal = removeLine(room, line);
        await invitationsListed;
      },
      after: () => landed(),
    });
    on({
      match: (url, method) => method === "DELETE" && url.pathname === `/repos/${fullName}/collaborators/${ben!.login}`,
      run: async () => {
        listed();
        await putLanded;
      },
    });
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const removed = await removal!;
    expect(removed.statusCode, removed.body).toBe(204);
    // The invitation's re-check found its grant revoked: it took itself back.
    expect(seats(fullName)[ben!.login]).toBeUndefined();
    expect(pendingInvitations(fullName)).not.toContain(ben!.login);
  });

  it("revokes past a first provisioning whose claim went stale (treated as failed)", async () => {
    const [ana] = [await newStudent()];
    const { project, room } = await groupProject([ana!], [[0]]);
    const [group] = await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, project.id));
    // A provisioning that died before GitHub made anything: pending, claimed ten minutes ago.
    const repoId = randomUUID();
    await server.app.db.insert(projectRepos).values({
      id: repoId,
      projectId: project.id,
      userId: ana!.id,
      groupId: group!.id,
      provisionStatus: "pending",
      provisionClaimedAt: new Date(Date.parse(NOW) - 10 * 60_000),
      acceptedAt: new Date(NOW),
    });
    await server.app.db.insert(projectRepoAccess).values({
      id: randomUUID(),
      repoId,
      enrollmentId: room.lines.get(ana!.id)!,
      githubUserId: ana!.githubUserId,
      githubLogin: ana!.login,
      invitedAt: new Date(NOW),
    });
    const res = await removeLine(room, room.lines.get(ana!.id)!);
    expect(res.statusCode, res.body).toBe(204);
    const [revoke] = await auditsOf(repoId, "project_group.repo_revoke");
    expect(revoke!.payload).toMatchObject({ outcome: "skipped", reason: "not_provisioned" });
  });

  it("deletes a classroom whose lines hold recorded accounts", async () => {
    const [ana] = [await newStudent()];
    const { project, room } = await groupProject([ana!], [[0]]);
    expect((await accept(project.id, ana!)).statusCode).toBe(200);
    const [row] = await repoRows(project.id);
    expect(await grantsOf(row!.id)).toHaveLength(1);
    const [roomRow] = await server.app.db.select().from(enrollments).where(eq(enrollments.classroomId, room.id));
    expect(roomRow).toBeDefined();
    const { classrooms } = await import("../../db/schema.js");
    const [named] = await server.app.db.select({ name: classrooms.name }).from(classrooms).where(eq(classrooms.id, room.id));
    const res = await staff("DELETE", `/app/api/classrooms/${room.id}?confirm=${encodeURIComponent(named!.name)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await server.app.db.select().from(projects).where(eq(projects.id, project.id))).toEqual([]);
    expect(await grantsOf(row!.id)).toEqual([]);
  });

  it("backfills an individual repository provisioned before 0067 (its student linked today)", async () => {
    const ana = await newStudent();
    const room = await connectedClassroom([ana]);
    const created = await staff("POST", `/app/api/classrooms/${room.id}/projects`, { name: "Before", sourceRepo: "starter", deadlineAt: IN_A_WEEK });
    const project = ProjectSummary.parse(created.json());
    // A row as M3-03 left it: provisioned, invited, no account recorded.
    const repoId = randomUUID();
    await server.app.db.insert(projectRepos).values({
      id: repoId,
      projectId: project.id,
      userId: ana.id,
      fullName: `${room.login}/before-${ana.login}`,
      githubRepoId: nextOrg++,
      provisionStatus: "ok",
      invitationStatus: "accepted",
      acceptedAt: new Date(NOW),
    });
    const migration = readFileSync(new URL("../../../drizzle/0067_project_repo_access.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf("INSERT INTO"));
    await server.app.db.execute(sql.raw(backfill));
    const grants = await grantsOf(repoId);
    expect(grants.map((g) => [g.enrollmentId, g.githubUserId, g.githubLogin, g.invitedAt, g.revokedAt])).toEqual([
      [room.lines.get(ana.id), ana.githubUserId, ana.login, new Date(NOW), null],
    ]);
  });
});
