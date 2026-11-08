/**
 * The world every project, codespace and GitHub-project test file builds:
 * a server with Quiz's App (`APP_ENV`), the fake GitHub
 * (`github/testing.ts`), the local bare repositories git really pushes to
 * (`modules/project/testing.ts`), GitHub's accounts by immutable id, and a
 * teacher. A test file calls {@link useProjectWorld} once, at its top, and
 * keeps what is its own (routes, hooks, builders) beside it.
 *
 * Module state, one copy per test file: vitest isolates every file's module
 * graph, so `server`, `teacher` and the counters are the file's own.
 *
 * Test support only; nothing in the application imports it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, vi } from "vitest";

import { githubAccounts, githubClassroomLinks, githubOrganizations } from "../db/schema.js";
import { setRemoteBaseForTests } from "../github/git.js";
import { appKey, fakeGithub, json, type Route } from "../github/testing.js";
import { repoWorld } from "../modules/project/testing.js";
import { testServer, type Method, type TestServer } from "./http.js";

export const key = appKey();
export const gh = fakeGithub();
export const world = repoWorld();
export const WEBHOOK_SECRET = "w".repeat(40);
/** The configuration of Quiz's App, as every project test file runs it. */
export const APP_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

export type Headers = Record<string, string>;

export let server: TestServer;
export let teacher: { id: string; headers: Headers };

let nextOrg = 10_000;
let nextAccount = 50_000;
/** A fresh GitHub id: an organization's (and its installation's). */
export const freshOrgId = () => nextOrg++;
/** A fresh GitHub account id. */
export const freshAccountId = () => nextAccount++;

/** GitHub's accounts, by immutable id: today's login, or `down` for GitHub failing. Missing: deleted. */
export const accounts = new Map<number, string>();
/** `GET /user/{id}`, answered from {@link accounts}. */
export const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  if (login === "down") return json({ message: "Server Error" }, 500);
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** A request on the server, as `headers`' owner. */
export const call = (method: Method, url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
/** A request on the server, as {@link teacher}. */
export const staffCall = (method: Method, url: string, payload?: object) => call(method, url, teacher.headers, payload);

export interface Student {
  id: string;
  headers: Headers;
  githubUserId: number;
  login: string;
}

/** `userId`'s GitHub account linked, and known to GitHub. */
export async function link(userId: string, githubUserId: number, login: string): Promise<void> {
  await server.app.db.insert(githubAccounts).values({ userId, githubUserId, login });
  accounts.set(githubUserId, login);
}

/**
 * A signed-in student with a linked GitHub account (unless `linked: false`),
 * logged in as `login`, else as `prefix` (`kid`) and the account's id.
 */
export async function newStudent(opts: { linked?: boolean; login?: string; prefix?: string } = {}): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = freshAccountId();
  const login = opts.login ?? `${opts.prefix ?? "kid"}${githubUserId}`;
  if (opts.linked !== false) await link(signed.id, githubUserId, login);
  return { ...signed, githubUserId, login };
}

export interface Org {
  /** The organization's GitHub id, its installation's too. */
  n: number;
  login: string;
  /** Its row. */
  orgId: string;
}

/**
 * An organization `<prefix>-<id>` with Quiz's App installed: known to the
 * repositories' world and stored. Its repositories are the caller's.
 */
export async function newOrg(prefix: string): Promise<Org> {
  const n = freshOrgId();
  const login = `${prefix}-${n}`;
  world.orgIds[login] = n;
  const orgId = randomUUID();
  await server.app.db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  return { n, login, orgId };
}

/** `classroomId` connected to the organization `orgId`, by `by` (the teacher). */
export async function linkClassroom(classroomId: string, orgId: string, by: string = teacher.id): Promise<void> {
  await server.app.db.insert(githubClassroomLinks).values({ classroomId, orgId, linkedBy: by, linkedAt: new Date() });
}

export interface WorldOptions {
  /** Added to (or overriding) {@link APP_ENV}. */
  env?: Record<string, string>;
  /** The fake GitHub's routes, set once the server is up. */
  routes: Route[];
  /** What answers `fetch` (the fake GitHub's, by default). */
  fetch?: typeof gh.fetch;
  /** Whether git's remotes point at the local bare repositories (yes, by default). */
  repos?: boolean;
  /** Whether a teacher signs in (`teacher`; yes, by default). */
  teacher?: boolean;
}

/**
 * Registers the world's lifecycle in the calling test file. Its `beforeAll`
 * runs before the file's own, its `afterAll` after the file's own.
 */
export function useProjectWorld(opts: WorldOptions): void {
  const repos = opts.repos ?? true;
  beforeAll(async () => {
    vi.stubGlobal("fetch", opts.fetch ?? gh.fetch);
    if (repos) setRemoteBaseForTests(`file://${world.dir}`);
    server = await testServer({ ...APP_ENV, ...opts.env });
    gh.routes = opts.routes;
    if (opts.teacher ?? true) teacher = await server.signIn("teacher");
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllGlobals();
    if (repos) setRemoteBaseForTests(null);
    world.remove();
    key.remove();
  });
}
