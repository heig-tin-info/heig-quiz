/**
 * The grading screen's evidence for git and automatic criteria (ADR-119
 * §8, card L-06e), on a server built with Quiz's App against the fake
 * GitHub, the rows written directly as the passes leave them:
 *
 * - an automatic criterion's CI log is read through its own route, never
 *   in the grading payload (its rows: `criteriaGrading.db.test.ts`);
 * - the commit graph: the handed-out branch's commits with their parents (a
 *   merge), the declared author, the member GitHub matched (a group's
 *   colours), the receipt times, the App's and the handed-out commits
 *   marked; never an e-mail address;
 * - cached as the live state: a second view asks GitHub nothing, a push
 *   forgets it; GitHub failing answers `unavailable` without a URL;
 * - staff only: an outsider, a student and an impersonation get the 404 of
 *   a missing project, a SEB or kiosk session the 401 of a confined one;
 *   the logs and the graph are absent from every student response.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CSRF_COOKIE, ProjectCommitGraph } from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import {
  botCommits,
  enrollments,
  githubAccounts,
  githubOrganizations,
  gradeDispatches,
  kioskDevices,
  projectCiResults,
  projectCriteria,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { createSession, SESSION_COOKIE, type NewSession } from "../../auth/session.js";
import { forgetRepoLiveState, LIVE_STATE_TTL_MS, resetLiveStateCache } from "../../github/metrics.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { writeCriterionGrades } from "./criterionGrades.js";

const CRITERIA = [
  "schema_version: 3",
  "criteria:",
  "  code:",
  "    tests: {description: Tests, max_points: 10, command: [make, test]}",
  "    format: {description: Format, max_points: 1, command: [make, format]}",
  "  rapport:",
  "    style: {description: Style, max_points: 2, prompt: Is the code readable?}",
  "  git:",
  "    commits: {description: Who committed the work, max_points: 2}",
  "",
].join("\n");
const LOG_SECRET = "Ci-log-secret <script>alert(1)</script>";
const MESSAGE_SECRET = "Graph-message-secret";
const AUTHOR_SECRET = "Graph-Author-Secret";
const EMAIL_SECRET = "graph.author-secret@heig-vd.ch";

const key = appKey();
const gh = fakeGithub();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const NOW = "2026-10-10T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const at = (iso: string) => new Date(iso);
const sha = (c: string) => c.repeat(40);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 71_000;

const call = (url: string, headers: Headers = teacher.headers) => server.app.inject({ method: "GET", url, headers });

/**
 * The fake GitHub's history of every student repository: a ← b ← c, b ← f,
 * m merges c and f, d the App's deadline commit on m; `a` is the
 * distribution's head. `b` is the linked member's (account 501), `f` a
 * second member's (502), `c` an unknown account's.
 */
const author = (name: string, id: number | null) => ({
  commit: { message: "", author: { name, email: EMAIL_SECRET, date: NOW } },
  author: id === null ? null : { login: `user-${id}`, id, type: "User" },
});
const HISTORY = [
  { sha: sha("d"), parents: ["m"], ...author("quiz-test[bot]", null), message: "Deadline" },
  { sha: sha("m"), parents: ["c", "f"], ...author("Ada Member", 501), message: "Merge branch 'parser'" },
  { sha: sha("f"), parents: ["b"], ...author("Bob Member", 502), message: `${MESSAGE_SECRET} parser` },
  { sha: sha("c"), parents: ["b"], ...author(AUTHOR_SECRET, 999), message: "Split words" },
  { sha: sha("b"), parents: ["a"], ...author("Ada Member", 501), message: "Read a line\n\nFrom stdin." },
  { sha: sha("a"), parents: [], ...author("HEIG-VD", null), message: "Initial commit" },
].map(({ sha: s, parents, commit, author: account, message }) => ({
  sha: s,
  parents: parents.map((p) => ({ sha: sha(p) })),
  commit: { ...commit, message },
  author: account,
}));
/** Repositories GitHub fails on (a 500). */
const failing = new Set<string>();
const commitsRoute: Route = (url, req) => {
  if (url.host !== "api.github.com" || req.method !== "GET") return undefined;
  let m = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(url.pathname);
  if (m) {
    if (failing.has(`${m[1]}/${m[2]}`)) return json({ message: "boom" }, 500);
    if (url.searchParams.get("sha") !== "main") return json({ message: "No commit found" }, 404);
    return json(url.searchParams.get("page") === "1" ? HISTORY : []);
  }
  m = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads(?:\/|%2F)main$/.exec(url.pathname);
  if (m && m[2]!.endsWith("-squashed")) return json({ ref: "refs/heads/main", object: { sha: sha("a"), type: "commit" } });
  return undefined;
};
const listings = () => gh.calls.filter((c) => /\/commits$/.test(c)).length;

interface World {
  projectId: string;
  classroomId: string;
  students: { id: string; headers: Headers }[];
  enrollmentIds: string[];
  org: string;
  evaluationId: string;
}

/** A locked v3 project graded by criteria, past its deadline, with its snapshot; no repository yet. */
async function world(): Promise<World> {
  const db = server.app.db;
  const people = await Promise.all([server.signIn("student"), server.signIn("student")]);
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: people.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const org = `gorg-${n}`;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    classroomId: seeded.classroomId,
    orgId,
    name: "Lab",
    slug: `lab-${n}`,
    state: "locked",
    startAt: at("2026-10-01T08:00:00Z"),
    deadlineAt: at(DEADLINE),
    deadlineAppliedAt: at(DEADLINE),
    sourceRepoId: n,
    sourceFullName: `${org}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `${org}/lab-squashed`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "criteria",
    gradingScale: { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
  });
  const parsed = parseCriteria(CRITERIA, { version: 3 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db.insert(projectCriteria).values({ projectId, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  const lines = await db.select({ id: enrollments.id, userId: enrollments.userId }).from(enrollments);
  const enrollmentIds = people.map((p) => lines.find((l) => l.userId === p.id)!.id);
  return { projectId, classroomId: seeded.classroomId, students: people, enrollmentIds, org, evaluationId: seeded.evaluationId };
}

/** The repository of `userId` (of `groupId` when given), frozen for good. */
async function repoOf(w: World, userId: string, patch: Partial<typeof projectRepos.$inferInsert> = {}) {
  const id = randomUUID();
  const n = nextOrg++;
  const fullName = `${w.org}/lab-${n}`;
  await server.app.db.insert(projectRepos).values({
    id,
    projectId: w.projectId,
    userId,
    githubRepoId: n,
    fullName,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: at("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    rulesetId: n,
    deadlineAppliedAt: at(DEADLINE),
    frozenAt: at("2026-10-09T22:30:00Z"),
    ...patch,
  });
  return { id, githubRepoId: n, fullName };
}

/** A settled CI pass of `repoId` and its stored results. */
async function ciPass(repoId: string, results: Record<string, { score: string; log?: string }>, createdAt: string) {
  const passId = randomUUID();
  await server.app.db.insert(gradeDispatches).values({ id: passId, repoId, trigger: "regrade", sha: sha("m"), nonce: randomUUID(), closedAt: at(createdAt) });
  await server.app.db.insert(projectCiResults).values({ passId, workflowRunId: Math.floor(Math.random() * 1e9), results: { criteria: results }, createdAt: at(createdAt) });
  return passId;
}

const graphUrl = (w: World, repoId: string) => `/app/api/projects/${w.projectId}/repos/${repoId}/commits`;
async function graph(w: World, repoId: string) {
  const res = await call(graphUrl(w, repoId));
  expect(res.statusCode, res.body).toBe(200);
  return ProjectCommitGraph.parse(res.json());
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [commitsRoute, orgsRoute(() => [])];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  resetLiveStateCache();
  failing.clear();
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

describe("the commit graph (ADR-119 §8)", () => {
  it("lists the handed-out branch with its merge, the declared authors, the members' colours, receipts and marks", async () => {
    const w = await world();
    const db = server.app.db;
    const [groupId] = [randomUUID()];
    await db.insert(projectGroups).values({ id: groupId, projectId: w.projectId, name: "G1", slug: "g1", position: 0 });
    await db.insert(projectGroupMembers).values(w.enrollmentIds.map((enrollmentId) => ({ id: randomUUID(), projectId: w.projectId, groupId, enrollmentId })));
    await db.insert(githubAccounts).values([
      { userId: w.students[0]!.id, githubUserId: 501, login: "ada-gh" },
      { userId: w.students[1]!.id, githubUserId: 502, login: "bob-gh" },
    ]);
    const repo = await repoOf(w, w.students[0]!.id, { groupId });
    await db.insert(pushReceipts).values([
      { id: randomUUID(), githubRepoId: repo.githubRepoId, branch: "main", headSha: sha("c"), receivedAt: at("2026-10-05T10:00:00Z") },
      { id: randomUUID(), githubRepoId: repo.githubRepoId, branch: "main", headSha: sha("m"), receivedAt: at("2026-10-06T10:00:00Z") },
    ]);
    await db.insert(botCommits).values({ repoId: repo.id, sha: sha("d"), kind: "deadline" });

    const got = await graph(w, repo.id);
    if (got.status !== "ok") throw new Error(got.status);
    const names = got.members.map((m) => m.login);
    expect(names.sort()).toEqual(["ada-gh", "bob-gh"]);
    const index = (login: string) => got.members.findIndex((m) => m.login === login);
    const bySha = Object.fromEntries(got.commits.map((c) => [c.sha, c]));
    expect(got.branches).toEqual([{ name: "main", head: sha("d") }]);
    expect(bySha[sha("m")]).toMatchObject({ parents: [sha("c"), sha("f")], authorName: "Ada Member", member: index("ada-gh"), mark: null, receivedAt: "2026-10-06T10:00:00.000Z" });
    expect(bySha[sha("f")]).toMatchObject({ member: index("bob-gh"), receivedAt: "2026-10-06T10:00:00.000Z" });
    expect(bySha[sha("c")]).toMatchObject({ authorName: AUTHOR_SECRET, member: null, receivedAt: "2026-10-05T10:00:00.000Z" });
    expect(bySha[sha("b")]).toMatchObject({ message: "Read a line\n\nFrom stdin.", receivedAt: "2026-10-05T10:00:00.000Z" });
    expect(bySha[sha("a")]).toMatchObject({ mark: "handout" });
    expect(bySha[sha("d")]).toMatchObject({ mark: "app", receivedAt: null });
    expect(JSON.stringify(got)).not.toContain(EMAIL_SECRET);
  });

  it("is read once through the cache, forgotten by a push, refreshed in the background past the TTL", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    const before = listings();
    await graph(w, repo.id);
    await graph(w, repo.id);
    expect(listings() - before).toBe(1);
    forgetRepoLiveState(repo.fullName);
    expect((await graph(w, repo.id)).status).toBe("ok");
    expect(listings() - before).toBe(2);
    // Past the TTL: the last graph at once, stale, while a fetch refreshes it.
    vi.useFakeTimers({ now: Date.now() + LIVE_STATE_TTL_MS + 1_000, toFake: ["Date"] });
    try {
      const stale = await graph(w, repo.id);
      expect(stale).toMatchObject({ status: "ok", stale: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers unavailable, without a URL, when GitHub fails or there is no repository", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    failing.add(repo.fullName);
    const res = await call(graphUrl(w, repo.id));
    expect(res.json()).toEqual({ status: "unavailable", reason: "github" });
    expect(res.body).not.toMatch(/github\.com|token/);
    const none = await repoOf(w, w.students[1]!.id, { fullName: null, githubRepoId: null });
    expect(await graph(w, none.id)).toEqual({ status: "unavailable", reason: "no_repo" });
  });
});

describe("staff only (invariant 6, N-SEC-20)", () => {
  it("gives an outsider and a student the 404 of a missing project, and no student response holds a log or the graph", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    await db().insert(githubAccounts).values({ userId: w.students[0]!.id, githubUserId: 600_000 + nextOrg, login: `ada-${nextOrg}` });
    const pass = await ciPass(repo.id, { "code.tests": { score: "7/10", log: LOG_SECRET } }, "2026-10-10T07:00:00Z");
    await writeCriterionGrades(db(), repo.id, [{ criterionId: "code.tests", points: 7, max: 10, source: "auto", state: "proposed", rationale: "7/10", passId: pass }], at(NOW));
    // The staff read both, warming the graph's cache; the grading payload marks the log, never carries it.
    const logUrl = (projectId: string) => `/app/api/projects/${projectId}/repos/${repo.id}/criteria/code.tests/ci-log`;
    expect(JSON.stringify(await graph(w, repo.id))).toContain(MESSAGE_SECRET);
    const staffGrading = await call(`/app/api/projects/${w.projectId}/grading`);
    expect(staffGrading.body).toContain('"ciLog":true');
    expect(staffGrading.body).not.toContain("Ci-log-secret");
    expect((await call(logUrl(w.projectId))).json()).toEqual({ log: LOG_SECRET });

    const missingGraph = await call(graphUrl({ ...w, projectId: randomUUID() }, repo.id));
    const missingLog = await call(logUrl(randomUUID()));
    expect([missingGraph.statusCode, missingLog.statusCode]).toEqual([404, 404]);
    const outsider = await server.signIn("teacher");
    const student = w.students[0]!;
    // The teacher's own seat, through a session that is not their portal: an admin's impersonation, SEB, a kiosk station.
    const admin = await server.signIn("admin");
    const deviceId = randomUUID();
    await db().insert(kioskDevices).values({ id: deviceId, googleDeviceId: `mock-${deviceId}`, status: "active", label: "Poste 1" });
    const confined = await Promise.all([
      sessionOf(teacher.id, { kind: "impersonation", actorUserId: admin.id, evaluationId: null, projectId: null }),
      sessionOf(teacher.id, { kind: "seb", actorUserId: null, evaluationId: w.evaluationId, projectId: null }),
      sessionOf(teacher.id, { kind: "kiosk", actorUserId: null, evaluationId: w.evaluationId, projectId: null, deviceId }),
    ]);
    for (const headers of [outsider.headers, student.headers, ...confined]) {
      const graphRes = await call(graphUrl(w, repo.id), headers);
      const logRes = await call(logUrl(w.projectId), headers);
      // A SEB or kiosk session is confined to its evaluation: refused as unauthenticated before any loader, as on every portal route.
      if (headers === confined[1] || headers === confined[2]) {
        expect([graphRes.statusCode, logRes.statusCode]).toEqual([401, 401]);
        expect(`${graphRes.body}${logRes.body}`).not.toMatch(/Ci-log-secret|Graph-message-secret/);
        continue;
      }
      expect([graphRes.statusCode, graphRes.body]).toEqual([404, missingGraph.body]);
      expect([logRes.statusCode, logRes.body]).toEqual([404, missingLog.body]);
      expect((await call(`/app/api/projects/${w.projectId}/grading`, headers)).statusCode).toBe(404);
    }

    const bodies: string[] = [];
    for (const url of [`/app/api/student/projects/${w.projectId}`, "/app/api/student/home", `/app/api/student/classrooms/${w.classroomId}`]) {
      const res = await call(url, student.headers);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      bodies.push(res.body);
    }
    // The student's own criteria table is there: the search is not vacuous.
    expect(bodies[0]).toContain("code.tests");
    for (const body of bodies) {
      for (const secret of ["Ci-log-secret", "alert(1)", '"ciLog"', '"log"', MESSAGE_SECRET, AUTHOR_SECRET, EMAIL_SECRET, sha("m"), "Ada Member"]) {
        expect(body, secret).not.toContain(secret);
      }
    }
  });
});

const db = () => server.app.db;

/** A session of `userId` of another kind than the portal's, as its cookies. */
async function sessionOf(userId: string, auth: NewSession): Promise<Headers> {
  const s = await createSession(db(), userId, 8, auth);
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}
