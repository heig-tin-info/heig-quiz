/**
 * The online workspace's git relay, Quiz's side (ADR-078, merge task M6-10),
 * over the real application with Quiz's App against the fake GitHub and the
 * local bare repositories, the portal a stub, the clock moved by hand:
 *
 * - `POST /app/codespace/git-token`: a token on ONE repository id with
 *   `contents` alone (write on the student's own, read on an `online_seb`
 *   distribution), `useUntil` bounded by the effective deadline plus the
 *   grace, `no-store`, audited without the token; refused — and nothing
 *   minted — for another user's repository, another project's, an `online`
 *   project's distribution, a user who never launched, after the deadline
 *   plus the grace, a staff lock, an archived classroom, a project back in
 *   `free`, another audience, an expired or long-lived request, no `jti`;
 *   GitHub down is a 503 naming its status only;
 * - `POST /app/codespace/relay-heads`: the same checks, the rows recorded,
 *   idempotent;
 * - the attribution (§6): a push of Quiz's App whose head was declared is
 *   the student's (receipt, last commit, its run the score), an undeclared
 *   one — and a declared head that is one of the App's own commits — stays
 *   the App's;
 * - the minted token in no log line and no audit row.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GIT_TOKEN_AUDIENCE,
  GIT_TOKEN_PATH,
  GitTokenGrant,
  LAUNCH_AUDIENCE,
  PORTAL_ISSUER,
  ProjectSummary,
  RELAY_HEADS_AUDIENCE,
  RELAY_HEADS_PATH,
} from "@quiz/contracts";
import { GRADING_WORKFLOW_PATH, signHs256 } from "@quiz/domain";

import {
  auditLog,
  botCommits,
  classrooms,
  codespaceLaunches,
  codespaceRelays,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectGradeRuns,
  projectRepos,
  projects,
  pushReceipts,
  teacherGrants,
  webhookDeliveries,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, signedDelivery, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { repoWorld } from "../project/testing.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const SECRET = "s".repeat(40);
const HOOK_SECRET = "w".repeat(40);
const PORTAL = "http://portal.test";
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: HOOK_SECRET,
  CODESPACE_URL: PORTAL,
  CODESPACE_LAUNCH_SECRET: SECRET,
};
const APP_BOT = "quiz-test[bot]";
const NOW = "2026-10-07T08:00:00.000Z";
const DEADLINE = "2026-10-14T22:00:00.000Z";
/** The project's default grace is 30 minutes (F-PROJ-01). */
const GRACE_END = "2026-10-14T22:30:00.000Z";
const MINUTE = 60_000;

type Headers = Record<string, string>;
interface Person {
  id: string;
  headers: Headers;
}
interface Student extends Person {
  login: string;
}

let server: TestServer;
let owner: Person;
let nextOrg = 92_000;
let nextAccount = 95_000;

// ---------------------------------------------------------------- the fakes

/** Every scoped token GitHub minted: its installation, its body, the token. */
const minted: { installationId: number; body: { repository_ids?: number[]; permissions?: Record<string, string> }; token: string }[] = [];
/** GitHub answers the scoped mint with this status when set. */
let mintStatus: number | null = null;
/** The scoped mint: an access token asked with `repository_ids` (the App's own installation tokens fall through). */
const mintRoute: Route = (url, init) => {
  const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if (url.host !== "api.github.com" || init.method !== "POST" || !m || typeof init.body !== "string") return undefined;
  const body = JSON.parse(init.body) as (typeof minted)[number]["body"];
  if (!body.repository_ids) return undefined;
  if (mintStatus !== null) return json({ message: "boom" }, mintStatus);
  const token = `ghs_scoped${randomUUID().replaceAll("-", "")}`;
  minted.push({ installationId: Number(m[1]), body, token });
  return json({ token, expires_at: new Date(Date.parse(server.clock.now().toISOString()) + 60 * MINUTE).toISOString() }, 201);
};

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};
/** The CI of a commit: a GRADE annotation for every sha in `scored`. */
const scored = new Set<string>();
const ciRoute: Route = (url, req) => {
  if (url.host !== "api.github.com" || req.method !== "GET") return undefined;
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname))) {
    return scored.has(m[1]!)
      ? json({ total_count: 1, check_runs: [{ id: 1, check_suite: { id: 77 }, output: { annotations_count: 1 } }] })
      : json({ total_count: 0, check_runs: [] });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/check-runs\/\d+\/annotations$/.test(url.pathname)) {
    return json([{ annotation_level: "notice", title: "GRADE", message: "6/6" }]);
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(url.pathname)) return json({ total_count: 0, workflow_runs: [] });
  return undefined;
};

const portalStub = (url: URL, init: RequestInit) =>
  init.method === "PUT" ? json({ id: url.pathname.split("/").pop(), configKey: null, sebLink: null }) : json([]);
const fetchStub = (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return url.origin === PORTAL ? Promise.resolve(portalStub(url, init)) : gh.fetch(input, init);
};

/** Every line pino writes, as `codespace.db.test.ts` captures it. */
const logLines: string[] = [];
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

// ---------------------------------------------------------------- the world

const call = (method: "GET" | "POST" | "PUT", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function newStudent(): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `kid${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

interface Room extends Seeded {
  org: string;
  installationId: number;
}

async function connectedClassroom(students: { id: string }[]): Promise<Room> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: owner.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const org = `rorg-${n}`;
  world.orgIds[org] = n;
  world.source(org, "starter", { main: { "README.md": "# Lab", [GRADING_WORKFLOW_PATH]: "grade: v1" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: owner.id, linkedAt: new Date() });
  return { ...seeded, org, installationId: n };
}

async function onlineProject(room: Room, name: string, mode: "online" | "online_seb" = "online"): Promise<ProjectSummary> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, owner.headers, {
    name,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    protectedFiles: [GRADING_WORKFLOW_PATH],
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, owner.headers)).statusCode).toBe(200);
  expect((await call("PUT", `/app/api/projects/${summary.id}/workspace/mode`, owner.headers, { mode })).statusCode).toBe(200);
  return summary;
}

const accept = async (projectId: string, who: Person) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  expect(res.statusCode, res.body).toBe(200);
};
const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;
/** The student's launch through the start route (it records the launch, ADR-078 §6). */
const launch = async (projectId: string, headers: Headers) => {
  const res = await call("GET", `/app/codespace/start/${projectId}`, headers);
  expect(res.statusCode, res.body).toBe(303);
  expect(res.headers.location).toMatch(new RegExp(`^${PORTAL}/launch`));
};

/** A student who launched the workspace of a fresh online project: the fixture of most tests. */
async function launched(mode: "online" | "online_seb" = "online") {
  const student = await newStudent();
  const room = await connectedClassroom([student]);
  const project = await onlineProject(room, `Relay ${randomUUID().slice(0, 6)}`, mode);
  await accept(project.id, student);
  if (mode === "online") {
    await launch(project.id, student.headers);
  } else {
    // A launch under SEB comes from its `seb` session; the record is what the token route reads.
    const at = server.clock.now();
    await server.app.db.insert(codespaceLaunches).values({ projectId: project.id, userId: student.id, firstLaunchAt: at, lastLaunchAt: at });
  }
  const repo = await repoOf(project.id, student.id);
  const [row] = await server.app.db.select().from(projects).where(eq(projects.id, project.id));
  return { student, room, project, repo, distribution: { fullName: row!.distributionFullName!, id: row!.distributionRepoId! } };
}
type Fixture = Awaited<ReturnType<typeof launched>>;

/** A request token as the portal signs it; `over` replaces any claim. */
async function requestToken(aud: string, claims: { projectId: string; userId: string; repository: string }, over: Record<string, unknown> = {}) {
  const iat = Math.floor(server.clock.now().getTime() / 1000);
  return signHs256({ iss: PORTAL_ISSUER, aud, iat, exp: iat + 60, jti: randomUUID(), ...claims, ...over }, SECRET);
}
const post = (path: string, token: string) => server.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` } });
const askToken = async (f: Fixture, over: Record<string, unknown> = {}, repository = f.repo.fullName!) =>
  post(GIT_TOKEN_PATH, await requestToken(GIT_TOKEN_AUDIENCE, { projectId: f.project.id, userId: f.student.id, repository }, over));
const declare = async (f: Fixture, heads: { ref: string; sha: string }[], over: Record<string, unknown> = {}) =>
  post(RELAY_HEADS_PATH, await requestToken(RELAY_HEADS_AUDIENCE, { projectId: f.project.id, userId: f.student.id, repository: f.repo.fullName! }, { heads, ...over }));

const refused = (res: { statusCode: number; json: () => { error: string } }) => [res.statusCode, res.json().error];

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  captureLog(server.app);
  gh.routes = [mintRoute, orgsRoute(() => []), usersRoute, ciRoute, world.route];
  const email = `t-${randomUUID().slice(0, 8)}@heig.test`;
  owner = await server.signIn("teacher", email);
  await server.app.db.insert(teacherGrants).values({ id: randomUUID(), email, createdBy: owner.id, codespaceEnabled: true, codespaceMaxActiveSessions: 5 });
});

beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
  mintStatus = null;
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the token

describe("POST /app/codespace/git-token (ADR-078 §2)", () => {
  it("mints contents:write on the student's one repository, until the deadline plus the grace, audited without the token", async () => {
    const f = await launched();
    const [recorded] = await server.app.db
      .select()
      .from(codespaceLaunches)
      .where(and(eq(codespaceLaunches.projectId, f.project.id), eq(codespaceLaunches.userId, f.student.id)));
    expect(recorded?.firstLaunchAt.toISOString()).toBe(NOW);
    logLines.length = 0;
    minted.length = 0;

    const res = await askToken(f);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const grant = GitTokenGrant.parse(res.json());
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      installationId: f.room.installationId,
      body: { repository_ids: [f.repo.githubRepoId], permissions: { contents: "write" } },
    });
    expect(Object.keys(minted[0]!.body.permissions!)).toEqual(["contents"]);
    expect(grant).toMatchObject({
      token: minted[0]!.token,
      permission: "write",
      repository: { fullName: f.repo.fullName, githubRepoId: f.repo.githubRepoId },
      // A week before the deadline: GitHub's hour bounds it.
      expiresAt: new Date(Date.parse(NOW) + 60 * MINUTE).toISOString(),
      useUntil: new Date(Date.parse(NOW) + 60 * MINUTE).toISOString(),
    });

    const audits = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "codespace.git_token_issued"), eq(auditLog.subjectId, f.project.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({
      userId: f.student.id,
      repository: f.repo.fullName,
      githubRepoId: f.repo.githubRepoId,
      permission: "write",
      expiresAt: grant.expiresAt,
    });
    // The token: in no audit row, no log line (§4).
    const allAudits = JSON.stringify(await server.app.db.select().from(auditLog));
    expect(allAudits).not.toContain(grant.token);
    expect(logLines.join("\n")).not.toContain(grant.token);
    expect(logLines.join("\n")).toContain("codespace.git-token issued");
  });

  it("bounds useUntil by the effective deadline plus the grace near the end, and refuses once it passed", async () => {
    const f = await launched();
    server.clock.set(new Date(Date.parse(GRACE_END) - 20 * MINUTE).toISOString());
    const grant = GitTokenGrant.parse((await askToken(f)).json());
    expect(grant.useUntil).toBe(GRACE_END);
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.parse(grant.useUntil));

    minted.length = 0;
    server.clock.set(GRACE_END);
    expect(refused(await askToken(f))).toEqual([409, "closed"]);
    expect(refused(await declare(f, [{ ref: "refs/heads/main", sha: "a".repeat(40) }]))).toEqual([409, "closed"]);
    // An individual extension reopens it (§8).
    await server.app.db.update(projectRepos).set({ deadlineAt: new Date("2026-10-21T22:00:00Z") }).where(eq(projectRepos.id, f.repo.id));
    expect((await askToken(f)).statusCode).toBe(200);
    expect(minted).toHaveLength(1);
  });

  it("mints contents:read on the distribution of an online_seb project only", async () => {
    const exam = await launched("online_seb");
    minted.length = 0;
    const res = await askToken(exam, {}, exam.distribution.fullName);
    expect(res.statusCode, res.body).toBe(200);
    expect(GitTokenGrant.parse(res.json())).toMatchObject({ permission: "read", repository: { githubRepoId: exam.distribution.id } });
    expect(minted[0]!.body).toEqual({ repository_ids: [exam.distribution.id], permissions: { contents: "read" } });
    // A read grant is no relay target.
    const heads = [{ ref: "refs/heads/main", sha: "a".repeat(40) }];
    const tok = await requestToken(RELAY_HEADS_AUDIENCE, { projectId: exam.project.id, userId: exam.student.id, repository: exam.distribution.fullName }, { heads });
    expect(refused(await post(RELAY_HEADS_PATH, tok))).toEqual([404, "not_found"]);

    const lab = await launched("online");
    expect(refused(await askToken(lab, {}, lab.distribution.fullName))).toEqual([404, "not_found"]);
  });

  it("refuses, minting nothing: another user's or project's repository, no launch, a lock, an archive, free again", async () => {
    const f = await launched();
    const g = await launched();
    minted.length = 0;
    // Another student's repository, another project's.
    expect(refused(await askToken(f, {}, g.repo.fullName!))).toEqual([404, "not_found"]);
    expect(refused(await askToken(f, { projectId: g.project.id }))).toEqual([404, "not_found"]);
    // Somebody who never launched it.
    const stranger = await newStudent();
    expect(refused(await askToken(f, { userId: stranger.id }))).toEqual([404, "not_found"]);
    expect(refused(await askToken(f, { userId: "not-a-uuid", projectId: "nope" }))).toEqual([404, "not_found"]);
    // The staff's hand on the lock.
    await server.app.db.update(projectRepos).set({ staffLock: true }).where(eq(projectRepos.id, f.repo.id));
    expect(refused(await askToken(f))).toEqual([409, "closed"]);
    await server.app.db.update(projectRepos).set({ staffLock: null }).where(eq(projectRepos.id, f.repo.id));
    // An archived classroom.
    await server.app.db.update(classrooms).set({ archivedAt: new Date(NOW) }).where(eq(classrooms.id, f.room.classroomId));
    expect(refused(await askToken(f))).toEqual([409, "closed"]);
    await server.app.db.update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, f.room.classroomId));
    // A corrupted mode (it is frozen once launched).
    await server.app.db.update(projects).set({ workMode: "free" }).where(eq(projects.id, f.project.id));
    expect(refused(await askToken(f))).toEqual([409, "not_online"]);
    await server.app.db.update(projects).set({ workMode: "online" }).where(eq(projects.id, f.project.id));
    expect(minted).toHaveLength(0);
    expect((await askToken(f)).statusCode).toBe(200);
  });

  it("refuses with a 401 any other audience, issuer, an expired or long-lived request, no jti, no signature", async () => {
    const f = await launched();
    minted.length = 0;
    const claims = { projectId: f.project.id, userId: f.student.id, repository: f.repo.fullName! };
    const iat = Math.floor(Date.parse(NOW) / 1000);
    const cases = [
      await requestToken(RELAY_HEADS_AUDIENCE, claims, { heads: [] }),
      await requestToken(LAUNCH_AUDIENCE, claims),
      await requestToken(GIT_TOKEN_AUDIENCE, claims, { iss: "heig-quiz" }),
      await requestToken(GIT_TOKEN_AUDIENCE, claims, { iat: iat - 600, exp: iat - 540 }),
      await requestToken(GIT_TOKEN_AUDIENCE, claims, { exp: iat + 3600 }),
      await requestToken(GIT_TOKEN_AUDIENCE, claims, { jti: undefined }),
      await signHs256({ iss: PORTAL_ISSUER, aud: GIT_TOKEN_AUDIENCE, iat, exp: iat + 60, jti: "x", ...claims }, "t".repeat(40)),
    ];
    for (const token of cases) expect(refused(await post(GIT_TOKEN_PATH, token))).toEqual([401, "unauthorized"]);
    const bare = await server.app.inject({ method: "POST", url: GIT_TOKEN_PATH });
    expect(refused(bare)).toEqual([401, "unauthorized"]);
    // The token route's own request is refused by the declaration route.
    expect(refused(await post(RELAY_HEADS_PATH, await requestToken(GIT_TOKEN_AUDIENCE, claims)))).toEqual([401, "unauthorized"]);
    expect(minted).toHaveLength(0);
  });

  it("answers 503 when GitHub refuses or the installation is gone, naming its status only", async () => {
    const f = await launched();
    logLines.length = 0;
    mintStatus = 502;
    expect(refused(await askToken(f))).toEqual([503, "github_unavailable"]);
    mintStatus = null;
    await server.app.db.update(githubOrganizations).set({ suspendedAt: new Date(NOW) }).where(eq(githubOrganizations.login, f.room.org));
    expect(refused(await askToken(f))).toEqual([503, "github_unavailable"]);
    expect(logLines.some((l) => l.includes("GitHub unavailable") && l.includes("502"))).toBe(true);
  });
});

// ---------------------------------------------------------------- the declaration and the attribution

const deliver = (payload: object, id = randomUUID()) => signedDelivery(server.app, HOOK_SECRET, payload, { event: "push", id });
async function handled(event: string, payload: object): Promise<void> {
  const id = randomUUID();
  const res = await signedDelivery(server.app, HOOK_SECRET, payload, { event, id });
  expect(res.statusCode, res.body).toBe(200);
  await vi.waitFor(
    async () => {
      const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
      expect(row?.error ?? null).toBeNull();
      expect(row?.processedAt).not.toBeNull();
    },
    { timeout: 20_000 },
  );
}
/** A commit landed on GitHub by the relay (`world.commit`), delivered as a push of `sender`. */
async function relayedPush(f: Fixture, files: Record<string, string>, sender = APP_BOT) {
  const before = world.git(f.repo.fullName!, "rev-parse", "main").trim();
  const after = world.commit(f.repo.fullName!, "main", files);
  return { before, after, payload: pushPayload(f, before, after, Object.keys(files), sender) };
}
function pushPayload(f: Fixture, before: string, after: string, modified: string[], sender: string) {
  return {
    ref: "refs/heads/main",
    before,
    after,
    forced: false,
    repository: { id: f.repo.githubRepoId, full_name: f.repo.fullName },
    sender: { login: sender },
    head_commit: { timestamp: server.clock.now().toISOString() },
    commits: [{ added: [], modified, removed: [] }],
  };
}
const receiptOf = async (sha: string) => (await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.headSha, sha)))[0];
const runPayload = (f: Fixture, sha: string) => ({
  action: "completed",
  repository: { id: f.repo.githubRepoId },
  workflow_run: {
    id: Math.floor(Math.random() * 1e9),
    run_attempt: 1,
    head_branch: "main",
    head_sha: sha,
    conclusion: "success",
    path: GRADING_WORKFLOW_PATH,
    event: "push",
    check_suite_id: 77,
    updated_at: server.clock.now().toISOString(),
    triggering_actor: { login: APP_BOT },
  },
});
const runsOf = (f: Fixture) => server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.repoId, f.repo.id));

describe("POST /app/codespace/relay-heads and the attribution (ADR-078 §6)", () => {
  it("records each declared head once, then reads the App's push of it as the student's: last commit, receipt, score", async () => {
    const f = await launched();
    const { after, payload } = await relayedPush(f, { "src/main.c": "int main(){return 0;}" });
    const heads = [{ ref: "refs/heads/main", sha: after }];
    const res = await declare(f, heads);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await declare(f, heads)).statusCode).toBe(204);
    const rows = await server.app.db.select().from(codespaceRelays).where(eq(codespaceRelays.sha, after));
    expect(rows).toEqual([
      { githubRepoId: f.repo.githubRepoId, sha: after, ref: "refs/heads/main", userId: f.student.id, declaredAt: new Date(NOW) },
    ]);

    await handled("push", payload);
    expect((await receiptOf(after))?.isBot).toBe(false);
    expect((await repoOf(f.project.id, f.student.id)).lastCommitSha).toBe(after);

    scored.add(after);
    const run = runPayload(f, after);
    await handled("workflow_run", run);
    const [graded] = (await runsOf(f)).filter((r) => r.workflowRunId === run.workflow_run.id);
    expect(graded).toBeDefined();
    expect((await repoOf(f.project.id, f.student.id)).currentGradeRunId).toBe(graded!.id);
  });

  it("checks the declared repository like the token's, and refuses more than 50 heads", async () => {
    const f = await launched();
    const g = await launched();
    const sha = "b".repeat(40);
    const other = await requestToken(RELAY_HEADS_AUDIENCE, { projectId: f.project.id, userId: f.student.id, repository: g.repo.fullName! }, { heads: [{ ref: "refs/heads/main", sha }] });
    expect(refused(await post(RELAY_HEADS_PATH, other))).toEqual([404, "not_found"]);
    const many = Array.from({ length: 51 }, (_, i) => ({ ref: `refs/heads/b${i}`, sha }));
    expect(refused(await declare(f, many))).toEqual([401, "unauthorized"]);
    expect(await server.app.db.select().from(codespaceRelays).where(eq(codespaceRelays.sha, sha))).toEqual([]);
  });

  it("keeps an undeclared App push the App's: not the last commit, a bot receipt, its run not counted", async () => {
    const f = await launched();
    const lastBefore = (await repoOf(f.project.id, f.student.id)).lastCommitSha;
    const { after, payload } = await relayedPush(f, { "notes.txt": "a sync, a deadline commit" });
    await handled("push", payload);
    expect((await receiptOf(after))?.isBot).toBe(true);
    expect((await repoOf(f.project.id, f.student.id)).lastCommitSha).toBe(lastBefore);
    scored.add(after);
    const run = runPayload(f, after);
    await handled("workflow_run", run);
    expect((await runsOf(f)).some((r) => r.workflowRunId === run.workflow_run.id)).toBe(false);
  });

  it("never counts one of the App's own commits as the student's, even declared", async () => {
    const f = await launched();
    const lastBefore = (await repoOf(f.project.id, f.student.id)).lastCommitSha;
    const { after, payload } = await relayedPush(f, { "README.md": "# restored" });
    // Quiz's restore: its bot commit recorded; a compromised or confused portal declares it anyway.
    await server.app.db.insert(botCommits).values({ repoId: f.repo.id, sha: after, kind: "revert" });
    expect((await declare(f, [{ ref: "refs/heads/main", sha: after }])).statusCode).toBe(204);
    await handled("push", payload);
    expect((await receiptOf(after))?.isBot).toBe(true);
    expect((await repoOf(f.project.id, f.student.id)).lastCommitSha).toBe(lastBefore);
  });

  it("restores a protected file a relayed push changed, as in free mode", async () => {
    const f = await launched();
    const { after, payload } = await relayedPush(f, { [GRADING_WORKFLOW_PATH]: "grade: always 6" });
    expect((await declare(f, [{ ref: "refs/heads/main", sha: after }])).statusCode).toBe(204);
    await handled("push", payload);
    const restored = world.git(f.repo.fullName!, "rev-parse", "main").trim();
    expect(restored).not.toBe(after);
    expect(world.read(f.repo.fullName!, restored, GRADING_WORKFLOW_PATH)).toBe("grade: v1");
  });

  it("a person's own push is unchanged by the relay records", async () => {
    const f = await launched();
    const { after, payload } = await relayedPush(f, { "x.c": "1" }, f.student.login);
    expect((await deliver(payload)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await receiptOf(after))?.isBot).toBe(false));
  });
});
