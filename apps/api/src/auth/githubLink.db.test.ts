/**
 * F-GH-05 over the real application (M2-03): the link round trip with GitHub
 * stubbed at `fetch` (no network), its refusals, the unlink, the Settings
 * card's state, and `linkedLogin`. Above all, invariant 15: the user token
 * of a link is found in no row of the database and in no line of the log.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThrottledOctokit } from "../github/app.js";
import {
  auditLog,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
} from "../db/schema.js";
import { testServer, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";
import { GITHUB_ACCOUNT_STALE, defaultProjectGradingScale } from "@quiz/contracts";

import { createApiToken } from "./tokens.js";
import { linkReturn } from "./githubLink.js";
import { linkedLogin } from "./linkedLogin.js";
import { CSRF_COOKIE, SESSION_COOKIE, createSession, type NewSession } from "./session.js";

const CLIENT_ID = "Iv1.quiztest";
const CLIENT_SECRET = "client-secret-of-the-test-app";
const STATE_COOKIE = "quiz_github_link";

type Who = { id: string; headers: Record<string, string> };

// ------------------------------------------------------------ GitHub, stubbed

/**
 * GitHub as `fetch` sees it: the code exchange, `GET /user`, the token's
 * revocation. Each code yields a fresh user token (`ghu_…`, the prefix the
 * log redaction knows — the test must not lean on that redaction, so the
 * search below is for the token's random part as well).
 */
const github = {
  /** The account `GET /user` answers; `status` other than 200 fails it. */
  user: { id: 4242, login: "octo-student" } as { id: number; login: string },
  userStatus: 200,
  exchangeRefused: false,
  tokens: [] as string[],
  revoked: [] as string[],
  /** The exchanges and reads; not the revocations, which may land after their test. */
  calls: 0,
};

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (url === `https://api.github.com/applications/${CLIENT_ID}/token` && init?.method === "DELETE") {
    github.revoked.push((JSON.parse(String(init.body)) as { access_token: string }).access_token);
    return new Response(null, { status: 204 });
  }
  github.calls += 1;
  if (url === "https://github.com/login/oauth/access_token") {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (github.exchangeRefused || body.client_secret !== CLIENT_SECRET || !body.code) {
      return Response.json({ error: "bad_verification_code" });
    }
    const token = `ghu_${randomUUID().replaceAll("-", "")}`;
    github.tokens.push(token);
    // What GitHub answers for an App's user token: an empty `scope`, which Octokit reads.
    return Response.json({ access_token: token, token_type: "bearer", scope: "" });
  }
  if (url === "https://api.github.com/user") {
    const token = headers.get("authorization")?.replace(/^(bearer|token) /i, "");
    if (!token || !github.tokens.includes(token)) return new Response(null, { status: 401 });
    if (github.userStatus !== 200) return Response.json({ message: "boom" }, { status: github.userStatus });
    return Response.json({ ...github.user, name: "Octo", email: null });
  }
  throw new Error(`unexpected fetch ${url}`);
});

// ------------------------------------------------------------ the server

let server: TestServer;
let keyDir: string;
/** Every line the application logged, from the first request on. */
const logLines: string[] = [];

function githubEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyDir = mkdtempSync(join(tmpdir(), "quiz-gh-link-"));
  const keyPath = join(keyDir, "app.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    GITHUB_APP_SLUG: "quiz-test",
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    PUBLIC_URL: "https://quiz.example",
  };
}

/**
 * Every line pino writes, at every level, captured: the request loggers are
 * children of `app.log` and share its destination stream. `testServer`
 * takes no log destination (and `test/` is not this task's to change), so
 * the stream is found by pino's own `pino.stream` symbol.
 */
function captureLog(app: TestServer["app"]) {
  const log = app.log as unknown as Record<symbol, { write: (line: string) => boolean }>;
  const streamSym = Object.getOwnPropertySymbols(Object.getPrototypeOf(log))
    .concat(Object.getOwnPropertySymbols(log))
    .find((s) => s.description === "pino.stream");
  if (!streamSym) throw new Error("pino stream not found");
  log[streamSym]!.write = (line: string) => {
    logLines.push(line);
    return true;
  };
  app.log.level = "trace";
}

// Stubbed for the whole file, not per test: the revocation is sent without
// being awaited, and must never reach the real `fetch` after a test ends.
beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  server = await testServer(githubEnv());
  captureLog(server.app);
});
afterAll(async () => {
  await server.close();
  rmSync(keyDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
beforeEach(() => {
  github.user = { id: Math.floor(Math.random() * 1e9) + 1, login: `octo-${randomUUID().slice(0, 6)}` };
  github.userStatus = 200;
  github.exchangeRefused = false;
  github.calls = 0;
});

// ------------------------------------------------------------ the round trip

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });

/** The state cookie as the browser stores it (still URL-encoded), and GitHub's `state`. */
async function begin(who: Who, returnPath?: string) {
  const query = returnPath === undefined ? "" : `?return=${encodeURIComponent(returnPath)}`;
  const res = await get(`/app/auth/github/link${query}`, who.headers);
  expect(res.statusCode).toBe(303);
  const location = new URL(res.headers.location as string);
  const setCookie = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(`${STATE_COOKIE}=`));
  return {
    res,
    location,
    nonce: location.searchParams.get("state")!,
    cookie: setCookie!.split(";")[0]!,
    setCookie: setCookie!,
  };
}

/** GitHub's redirect back; the `Location` it ends on. */
async function callback(who: Who, cookie: string | null, query: string) {
  const headers = { ...who.headers, cookie: [who.headers.cookie, cookie].filter(Boolean).join("; ") };
  const res = await get(`/app/auth/github/callback?${query}`, headers);
  expect(res.statusCode).toBe(303);
  return res.headers.location as string;
}

/** A whole link, from `who`'s page `returnPath`: where it lands. */
async function link(who: Who, returnPath = "/courses") {
  const { nonce, cookie } = await begin(who, returnPath);
  return callback(who, cookie, `code=the-code&state=${nonce}`);
}

const accountOf = async (userId: string) =>
  (await server.app.db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)))[0];

const auditOf = async (userId: string, action: string) =>
  (await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, userId))).filter(
    (r) => r.action === action,
  );

/** Headers of a session of another kind for `userId` (ADR-027, ADR-034). */
async function sessionOf(userId: string, auth: NewSession): Promise<Record<string, string>> {
  const s = await createSession(server.app.db, userId, 12, auth);
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

describe("GET /app/auth/github/link", () => {
  it("sends the browser to Quiz's App on GitHub, with a signed 10-minute state cookie", async () => {
    const student = await server.signIn("student");
    const { location, nonce, setCookie } = await begin(student, "/courses");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe("https://quiz.example/app/auth/github/callback");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/Path=\/app\/auth\/github/);
    // No GitHub call before the user comes back.
    expect(github.calls).toBe(0);
  });

  it("asks for a session", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/auth/github/link" });
    expect(res.statusCode).toBe(401);
  });
});

describe("the callback", () => {
  it("links the account and comes back to the page it started from, not to /", async () => {
    const student = await server.signIn("student");
    const back = await link(student, "/classrooms/abc/journal?page=2#top");
    expect(back).toBe("/classrooms/abc/journal?page=2&github=linked#top");
    const row = await accountOf(student.id);
    expect(row).toMatchObject({ githubUserId: github.user.id, login: github.user.login });
    const [entry] = await auditOf(student.id, "github.linked");
    expect(entry?.payload).toEqual({ githubUserId: github.user.id, login: github.user.login });
    // The token served GET /user once, then its revocation went to GitHub
    // (sent, not awaited: it may land after the redirect).
    await vi.waitFor(() => expect(github.revoked).toContain(github.tokens.at(-1)));
  });

  it("relinks the same user to another account", async () => {
    const student = await server.signIn("student");
    await link(student);
    github.user = { id: github.user.id + 1, login: "renamed-elsewhere" };
    expect(await link(student)).toBe("/courses?github=linked");
    expect((await accountOf(student.id))?.githubUserId).toBe(github.user.id);
  });

  it("refuses an account already another user's: ?github=conflict, nothing written", async () => {
    const first = await server.signIn("student");
    const second = await server.signIn("student");
    await link(first);
    expect(await link(second, "/courses/x")).toBe("/courses/x?github=conflict");
    expect(await accountOf(second.id)).toBeUndefined();
    expect((await accountOf(first.id))?.githubUserId).toBe(github.user.id);
    const [entry] = await auditOf(second.id, "github.link_conflict");
    expect(entry?.payload).toEqual({ githubUserId: github.user.id });
  });

  it("comes back with ?github=error when GitHub refuses the code, fails, or the user cancelled", async () => {
    const student = await server.signIn("student");
    github.exchangeRefused = true;
    expect(await link(student, "/courses")).toBe("/courses?github=error");
    github.exchangeRefused = false;
    github.userStatus = 502;
    expect(await link(student, "/courses")).toBe("/courses?github=error");
    const { nonce, cookie } = await begin(student, "/courses");
    const calls = github.calls;
    expect(await callback(student, cookie, `error=access_denied&state=${nonce}`)).toBe("/courses?github=error");
    expect(github.calls).toBe(calls);
    expect(await accountOf(student.id)).toBeUndefined();
  });

  describe("refuses a bad or expired state: no GitHub call, nothing written", () => {
    const refused = async (who: Who, cookie: string | null, query: string) => {
      expect(await callback(who, cookie, query)).toBe("/settings?github=error");
      expect(github.calls).toBe(0);
      expect(await accountOf(who.id)).toBeUndefined();
    };

    it("without the cookie", async () => {
      const student = await server.signIn("student");
      const { nonce } = await begin(student);
      await refused(student, null, `code=c&state=${nonce}`);
    });

    it("with another nonce", async () => {
      const student = await server.signIn("student");
      const { cookie } = await begin(student);
      await refused(student, cookie, "code=c&state=not-the-nonce");
    });

    it("with a cookie not signed by the server", async () => {
      const student = await server.signIn("student");
      const { nonce, cookie } = await begin(student);
      const [name, value] = cookie.split("=");
      const decoded = decodeURIComponent(value!);
      const forged = decoded.slice(0, decoded.lastIndexOf(".")).replace("/settings", "/evil") + ".AAAA";
      await refused(student, `${name}=${encodeURIComponent(forged)}`, `code=c&state=${nonce}`);
    });

    it("issued to another user", async () => {
      const student = await server.signIn("student");
      const other = await server.signIn("student");
      const { nonce, cookie } = await begin(other);
      await refused(student, cookie, `code=c&state=${nonce}`);
    });

    it("past its ten minutes by the server's clock", async () => {
      const student = await server.signIn("student");
      server.clock.set("2026-09-30T10:00:00.000Z");
      const { nonce, cookie } = await begin(student);
      server.clock.set("2026-09-30T10:10:00.000Z");
      await refused(student, cookie, `code=c&state=${nonce}`);
    });
  });

  it("clears the state cookie: a state serves once", async () => {
    const student = await server.signIn("student");
    const { nonce, cookie } = await begin(student);
    const headers = { ...student.headers, cookie: `${student.headers.cookie}; ${cookie}` };
    const res = await get(`/app/auth/github/callback?code=c&state=${nonce}`, headers);
    const cleared = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(`${STATE_COOKIE}=`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe("the return path", () => {
  it.each(["/", "/app/api/me", "//evil.example"])("refuses %j for the Settings page", (raw) => {
    expect(linkReturn(raw)).toBe("/settings");
  });

  it("keeps an in-app path, query included", () => {
    expect(linkReturn("/courses/abc?x=1")).toBe("/courses/abc?x=1");
    expect(linkReturn(undefined)).toBe("/settings");
  });

  it("lands on the Settings page when `return` is external", async () => {
    const student = await server.signIn("student");
    expect(await link(student, "//evil.example/steal")).toBe("/settings?github=linked");
  });
});

describe("sessions that may not link (ADR-027, ADR-034)", () => {
  let student: Who;
  let admin: Who;
  let evaluationId: string;

  beforeAll(async () => {
    student = await server.signIn("student");
    admin = await server.signIn("admin");
    const teacher = await server.signIn("teacher");
    ({ evaluationId } = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      questions: 0,
    }));
  });

  it("refuses an impersonation session: 403 session_required, on the link, the callback and the unlink", async () => {
    await server.app.db.insert(githubAccounts).values({ userId: student.id, githubUserId: 9_000_001, login: "kept" });
    const headers = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null });
    for (const [method, url] of [
      ["GET", "/app/auth/github/link?return=/courses"],
      ["GET", "/app/auth/github/callback?code=c&state=s"],
      ["DELETE", "/app/api/me/github"],
    ] as const) {
      const res = await server.app.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.headers["set-cookie"] ?? "").not.toContain(STATE_COOKIE);
    }
    expect((await accountOf(student.id))?.login).toBe("kept");
    expect(github.calls).toBe(0);
    await server.app.db.delete(githubAccounts).where(eq(githubAccounts.userId, student.id));
  });

  it.each(["seb", "kiosk"] as const)("does not serve a %s session: it is nobody here (401)", async (kind) => {
    const headers = await sessionOf(student.id, { kind, actorUserId: null, projectId: null, evaluationId });
    for (const [method, url] of [
      ["GET", "/app/auth/github/link?return=/courses"],
      ["GET", "/app/auth/github/callback?code=c&state=s"],
      ["DELETE", "/app/api/me/github"],
    ] as const) {
      const res = await server.app.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(github.calls).toBe(0);
  });
});

describe("/app/api/me/github", () => {
  it("unlinks, audits, and is idempotent", async () => {
    const student = await server.signIn("student");
    await link(student);
    const del = () => server.app.inject({ method: "DELETE", url: "/app/api/me/github", headers: student.headers });
    expect((await del()).statusCode).toBe(204);
    expect(await accountOf(student.id)).toBeUndefined();
    expect((await del()).statusCode).toBe(204);
    const entries = await auditOf(student.id, "github.unlinked");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ githubUserId: github.user.id, login: github.user.login });
  });

  it("refuses a Bearer token: 403, the link kept", async () => {
    const student = await server.signIn("student");
    await server.app.db.insert(githubAccounts).values({ userId: student.id, githubUserId: 9_000_400, login: "kept" });
    const { token } = await createApiToken(server.app.db, student.id, { name: "t", expiresInDays: null });
    const res = await server.app.inject({
      method: "DELETE",
      url: "/app/api/me/github",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "session_required" });
    expect((await accountOf(student.id))?.login).toBe("kept");
  });

  it("says whether the card is relevant: staff of a classroom connected to GitHub", async () => {
    const teacher = await server.signIn("teacher");
    const state = async () =>
      (await server.app.inject({ method: "GET", url: "/app/api/me/github", headers: teacher.headers })).json();
    expect(await state()).toEqual({ account: null, relevant: false });

    const { classroomId } = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [], questions: 0 });
    expect((await state()).relevant).toBe(false);
    const orgId = randomUUID();
    await server.app.db.insert(githubOrganizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
    await server.app.db.insert(githubClassroomLinks).values({ classroomId, orgId, linkedBy: teacher.id });
    expect((await state()).relevant).toBe(true);

    await link(teacher);
    const linked = await state();
    expect(linked.account.login).toBe(github.user.login);
    expect(Number.isNaN(Date.parse(linked.account.linkedAt))).toBe(false);
  });
  it("says whether the card is relevant: a claimed seat in a classroom connected to GitHub", async () => {
    const teacher = await server.signIn("teacher");
    const student = await server.signIn("student");
    const state = async () =>
      (await server.app.inject({ method: "GET", url: "/app/api/me/github", headers: student.headers })).json();

    const { classroomId } = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    expect(await state()).toEqual({ account: null, relevant: false });
    const orgId = randomUUID();
    await server.app.db.insert(githubOrganizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
    await server.app.db.insert(githubClassroomLinks).values({ classroomId, orgId, linkedBy: teacher.id });
    expect((await state()).relevant).toBe(true);
  });

  it("says whether the card is relevant: a project repository of one's own or of one's group, connected or not", async () => {
    const teacher = await server.signIn("teacher");
    const [owner, member, loner] = [await server.signIn("student"), await server.signIn("student"), await server.signIn("student")];
    const relevant = async (who: Who) =>
      (await server.app.inject({ method: "GET", url: "/app/api/me/github", headers: who.headers })).json().relevant;
    const db = server.app.db;

    // A classroom no longer connected: its projects' repositories remain.
    const { classroomId } = await seedLive(db, {
      teacherId: teacher.id,
      studentIds: [owner.id, member.id, loner.id],
      questions: 0,
    });
    const orgId = randomUUID();
    await db.insert(githubOrganizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      classroomId,
      orgId,
      name: "Lab",
      slug: "lab",
      startAt: new Date(),
      deadlineAt: new Date(),
      sourceRepoId: 1,
      sourceFullName: "org/lab-source",
      branches: ["main"],
      protectedFiles: [],
      gradingScale: defaultProjectGradingScale(),
      createdBy: teacher.id,
    });
    const seat = async (userId: string) =>
      (await db.select({ id: enrollments.id }).from(enrollments).where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.userId, userId))))[0]!.id;
    const [withRepo, without] = [randomUUID(), randomUUID()];
    await db.insert(projectGroups).values([
      { id: withRepo, projectId, name: "A", slug: "a", position: 0 },
      { id: without, projectId, name: "B", slug: "b", position: 1 },
    ]);
    await db.insert(projectGroupMembers).values([
      { id: randomUUID(), projectId, groupId: withRepo, enrollmentId: await seat(owner.id) },
      { id: randomUUID(), projectId, groupId: withRepo, enrollmentId: await seat(member.id) },
      { id: randomUUID(), projectId, groupId: without, enrollmentId: await seat(loner.id) },
    ]);
    expect([await relevant(owner), await relevant(member), await relevant(loner)]).toEqual([false, false, false]);

    // The owner accepts for the group: the group's repository is everyone's in it.
    await db.insert(projectRepos).values({ id: randomUUID(), projectId, userId: owner.id, groupId: withRepo, acceptedAt: new Date() });
    expect([await relevant(owner), await relevant(member), await relevant(loner)]).toEqual([true, true, false]);
  });
});

describe("the user token (invariant 15, N-SEC-16)", () => {
  it("is found in no row of the database and in no line of the log", async () => {
    const student = await server.signIn("student");
    await link(student);
    github.userStatus = 500; // a failure after the exchange: the path that logs
    await link(student);
    expect(github.tokens.length).toBeGreaterThan(0);
    // Everything the log ever said, then every row of every table.
    const log = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(log).toContain("GitHub account linking failed");
    // The request lines are there too, the callback's query masked.
    expect(log).toContain("/app/auth/github/callback…");
    const { rows } = (await server.app.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )) as unknown as { rows: { table_name: string }[] };
    let dump = "";
    for (const { table_name } of rows) {
      const all = (await server.app.db.execute(sql.raw(`SELECT t::text AS r FROM "${table_name}" t`))) as unknown as {
        rows: { r: string }[];
      };
      dump += all.rows.map((r) => r.r).join("\n");
    }
    expect(dump).toContain(github.user.login);
    for (const token of github.tokens) {
      const secret = token.slice("ghu_".length);
      expect(log).not.toContain(secret);
      expect(dump).not.toContain(secret);
    }
    // Nor the one-time code of the callback's URL, nor the App's client secret.
    expect(log).not.toContain("the-code");
    expect(log).not.toContain(CLIENT_SECRET);
  });
});

describe("linkedLogin", () => {
  /** An Octokit whose `GET /user/{id}` answers `status` with `login`. */
  const octokitAnswering = (status: number, login?: string) =>
    new ThrottledOctokit({
      request: {
        fetch: async () =>
          status === 200 ? Response.json({ id: 1, login }) : Response.json({ message: "x" }, { status }),
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }) as unknown as Octokit;

  it("follows a renamed account by its id, and audits github.renamed once", async () => {
    const student = await server.signIn("student");
    await server.app.db.insert(githubAccounts).values({ userId: student.id, githubUserId: 9_000_100, login: "old-name" });
    expect(await linkedLogin(server.app.db, octokitAnswering(200, "new-name"), student.id)).toBe("new-name");
    expect((await accountOf(student.id))?.login).toBe("new-name");
    expect(await linkedLogin(server.app.db, octokitAnswering(200, "new-name"), student.id)).toBe("new-name");
    const entries = await auditOf(student.id, "github.renamed");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorType: "system",
      payload: { githubUserId: 9_000_100, from: "old-name", to: "new-name" },
    });
  });

  it("is github_account_stale for a deleted account, or no link at all", async () => {
    const student = await server.signIn("student");
    expect(await linkedLogin(server.app.db, octokitAnswering(200, "x"), student.id)).toBe(GITHUB_ACCOUNT_STALE);
    await server.app.db.insert(githubAccounts).values({ userId: student.id, githubUserId: 9_000_200, login: "gone" });
    expect(await linkedLogin(server.app.db, octokitAnswering(404), student.id)).toEqual({
      error: "github_account_stale",
    });
    expect((await accountOf(student.id))?.login).toBe("gone");
  });

  it("throws on any other failure", async () => {
    const student = await server.signIn("student");
    await server.app.db.insert(githubAccounts).values({ userId: student.id, githubUserId: 9_000_300, login: "x" });
    await expect(linkedLogin(server.app.db, octokitAnswering(502), student.id)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("with GitHub off", () => {
  it("has no route at all: 404", async () => {
    const off = await testServer();
    try {
      const student = await off.signIn("student");
      for (const [method, url] of [
        ["GET", "/app/auth/github/link?return=/courses"],
        ["GET", "/app/auth/github/callback?code=c&state=s"],
        ["GET", "/app/api/me/github"],
        ["DELETE", "/app/api/me/github"],
      ] as const) {
        const res = await off.app.inject({ method, url, headers: student.headers });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await off.close();
    }
  });
});
