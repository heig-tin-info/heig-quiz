/**
 * The world of the group repositories' tests (merge tasks M3-15b-1,
 * M3-15b-2): a server built with Quiz's App against the fake GitHub and the
 * local bare repositories (`./testing.ts`), a teacher, students with linked
 * accounts, a connected classroom, a published group project following a
 * set, and the one-shot hooks a test interleaves a request with another's
 * by (`on`). A test file calls {@link useGroupWorld} once.
 *
 * Test support only; nothing in the application imports it.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";

import { GroupErrorCode, GroupSetDetail, ProjectAcceptErrorCode, ProjectSummary, RosterErrorCode } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { auditLog, enrollments, githubAccounts, githubClassroomLinks, githubOrganizations, projectRepoAccess, projectRepos } from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { repoWorld } from "./testing.js";


const key = appKey();
export const gh = fakeGithub();
export const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
export const config = loadConfig({ NODE_ENV: "test", ...ENV });
export const NOW = "2026-10-05T08:00:00.000Z";
export const IN_A_WEEK = "2026-10-12T22:00:00.000Z";

export type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export interface Student {
  id: string;
  headers: Headers;
  githubUserId: number;
  login: string;
}

export let server: TestServer;
export let teacher: { id: string; headers: Headers };
let nextOrg = 61_000;
let nextAccount = 81_000;
/** A fresh GitHub id: an organization's, a repository's. */
export const freshOrgId = () => nextOrg++;
/** A fresh GitHub account id. */
export const freshAccountId = () => nextAccount++;

/** GitHub's accounts, by immutable id: today's login. Missing: deleted. */
export const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

export const call = (method: Method, url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
export const staff = (method: Method, url: string, payload?: object) => call(method, url, teacher.headers, payload);
export const accept = (projectId: string, who: { headers: Headers }) => call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
export const acceptRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectAcceptErrorCode.parse(res.json().error)];
export const groupRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, GroupErrorCode.parse(res.json().error)];
export const rosterRefusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, RosterErrorCode.parse(res.json().error)];

/** A student with a linked GitHub account (unless `linked: false`). */
export async function newStudent(opts: { linked?: boolean } = {}): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = freshAccountId();
  const login = `kid${githubUserId}`;
  if (opts.linked !== false) await link(signed.id, githubUserId, login);
  return { ...signed, githubUserId, login };
}

export async function link(userId: string, githubUserId: number, login: string) {
  await server.app.db.insert(githubAccounts).values({ userId, githubUserId, login });
  accounts.set(githubUserId, login);
}

export interface Org {
  login: string;
  orgId: string;
}

export interface Room extends Org {
  id: string;
  /** The roster line of each student, by user id. */
  lines: Map<string, string>;
}

/** A classroom of `teacher`'s course connected to an organization holding `starter` (a new one, unless `org` is given). */
export async function connectedClassroom(students: Student[], org?: Org): Promise<Room> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  let at = org;
  if (!at) {
    const n = freshOrgId();
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

export async function setOk(res: { statusCode: number; body: string; json: () => unknown }): Promise<GroupSetDetail> {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return GroupSetDetail.parse(res.json());
}

/**
 * A published group project `Lab 1` of a fresh classroom of `students`,
 * following a set whose groups are `groups` (indexes into `students`),
 * named "Group 1", "Group 2"…
 */
export async function groupProject(students: Student[], groups: number[][], org?: Org) {
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

export const groupOf = (set: GroupSetDetail, name: string) => set.groups.find((g) => g.name === name)!;
export const moveTo = (set: GroupSetDetail, line: string, groupId: string | null) =>
  staff("PUT", `/app/api/group-sets/${set.set.id}/members/${line}`, { groupId });
export const repoRows = (projectId: string) => server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
export const grantsOf = (repoId: string) => server.app.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.repoId, repoId));
export const auditsOf = (subjectId: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
export const seats = (fullName: string) => Object.fromEntries(world.collaborators.get(fullName) ?? []);
export const pendingInvitations = (fullName: string) => [...(world.invitations.get(fullName)?.values() ?? [])];
/** The invitation of `login` accepted on GitHub: a collaborator from now on. */
export const acceptInvitation = (fullName: string, login: string) => {
  const pending = world.invitations.get(fullName)!;
  for (const [id, who] of pending) if (who === login) pending.delete(id);
};
export const removeLine = (room: Room, line: string) => staff("DELETE", `/app/api/classrooms/${room.id}/roster/${line}`);

/**
 * Hooks a matching GitHub call runs first (each once), before the call goes
 * on to the world, and `after` once it landed: how a test interleaves a
 * request with another's.
 */
export interface Hook {
  match: (url: URL, method: string) => boolean;
  run: () => Promise<void>;
  after?: () => void;
}
let hooks: Hook[] = [];
export const on = (h: Hook) => void hooks.push(h);
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
export const goneInstallations = new Set<number>();
const tokensRoute: Route = (url, req) => {
  const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  return req.method === "POST" && m && goneInstallations.has(Number(m[1])) ? json({ message: "Not Found" }, 404) : undefined;
};

/** Registers the world's lifecycle in the calling test file: the server with Quiz's App, the fake GitHub and its hooks, the clock at {@link NOW}. */
export function useGroupWorld(): void {
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
}
