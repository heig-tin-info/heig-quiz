/**
 * The staff's project page and a repository's runs (merge task M3-08a,
 * F-PROJ-13, F-PROJ-14), on a server built with Quiz's App against the fake
 * GitHub (`github/testing.ts`). Ported from heig-classroom's detail and
 * grade-sheet tests; the rows are written directly, as the pipeline of
 * M3-03…M3-05a leaves them.
 *
 * - one row per student of the roster, accepted or not, and a repository
 *   whose student left the roster;
 * - each flag, the final score's precedence (teacher, review, frozen,
 *   current) and its grade by the project's scale, `fellBack` included;
 * - "changed after release" and the primary action;
 * - the live state: never read for a deleted repository, a rate-limited
 *   cold read answers the stored state at once, a slow GitHub is cut by
 *   the budget;
 * - the run list's slots;
 * - N-SEC-20: a student, another teacher, an impersonation, a token: 404.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GradeRunList, ProjectDetail, type ProjectGradingScale } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import { enrollments, githubAccounts, githubOrganizations, gradeDispatches, projectGradeRuns, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { resetLiveStateCache } from "../../github/metrics.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { projectDetail } from "./detail.js";

const key = appKey();
const gh = fakeGithub();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const at = (iso: string) => new Date(iso);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 32_000;

/** Organizations whose installation GitHub answers with an exhausted quota. */
const limitedOrgs = new Set<string>();
/** Repositories GitHub never answers about: a slow GitHub. */
const hanging = new Set<string>();
const liveRoute: Route = (url, req) => {
  if (url.host !== "api.github.com" || req.method !== "GET") return undefined;
  const m = /^\/repos\/([^/]+)\/([^/]+)\/commits(\/[^/]+\/check-runs)?$/.exec(url.pathname);
  if (!m) return undefined;
  const [owner, name] = [m[1]!, m[2]!];
  if (limitedOrgs.has(owner)) {
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  }
  if (hanging.has(`${owner}/${name}`)) return new Promise<Response>(() => {}) as unknown as Response;
  if (m[3]) {
    return json({ check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] });
  }
  return json([{ sha: "b".repeat(40), commit: { committer: { date: NOW } } }]);
};

const call = (url: string, headers: Headers) => server.app.inject({ method: "GET", url, headers });

interface World {
  projectId: string;
  classroomId: string;
  org: string;
  students: { id: string; headers: Headers }[];
}

/**
 * A published project of a classroom of `students` claimed students and
 * an organization with Quiz's App; no repository yet.
 */
async function world(opts: { students?: number; scale?: ProjectGradingScale; state?: "draft" | "published" | "locked" } = {}): Promise<World> {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 2 }, () => server.signIn("student")));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const org = `vorg-${n}`;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    classroomId: seeded.classroomId,
    orgId,
    name: "Lab",
    slug: `lab-${n}`,
    state: opts.state ?? "published",
    startAt: at("2026-10-01T08:00:00Z"),
    deadlineAt: at(DEADLINE),
    sourceRepoId: n,
    sourceFullName: `${org}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `${org}/lab-squashed`,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: opts.scale ?? { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
  });
  return { projectId, classroomId: seeded.classroomId, org, students };
}

type RepoPatch = Partial<typeof projectRepos.$inferInsert>;
let nextRepo = 40_000;
/** The student's repository, provisioned and invited, as Accept leaves it. */
async function repoOf(w: World, userId: string, patch: RepoPatch = {}): Promise<string> {
  const id = randomUUID();
  const n = nextRepo++;
  await server.app.db.insert(projectRepos).values({
    id,
    projectId: w.projectId,
    userId,
    githubRepoId: n,
    fullName: `${w.org}/lab-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: at("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    rulesetId: n,
    ...patch,
  });
  return id;
}

type RunPatch = Partial<typeof projectGradeRuns.$inferInsert>;
/** A stored run of the repository: a scored `ci` run unless `patch` says otherwise. */
async function run(repoId: string, completedAt: string, patch: RunPatch = {}): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(projectGradeRuns).values({
    id,
    repoId,
    workflowRunId: Math.floor(Math.random() * 1e9),
    headBranch: "main",
    headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    conclusion: "success",
    points: 8,
    max: 10,
    parseStatus: "ok",
    completedAt: at(completedAt),
    ...patch,
  });
  return id;
}

const setRepo = (id: string, patch: RepoPatch) => server.app.db.update(projectRepos).set(patch).where(eq(projectRepos.id, id));

async function detail(projectId: string, headers = teacher.headers): Promise<ProjectDetail> {
  const res = await call(`/app/api/projects/${projectId}`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectDetail.parse(res.json());
}
const rowOf = (d: ProjectDetail, userId: string) => d.rows.find((r) => r.student.userId === userId)!;
/** GitHub calls about the repositories whose `owner/name` starts with `prefix`. */
const liveCalls = (prefix: string) => gh.calls.filter((c) => c.includes(`/repos/${prefix}`)).length;

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), liveRoute];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  resetLiveStateCache();
  limitedOrgs.clear();
  hanging.clear();
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

describe("the project page (F-PROJ-13)", () => {
  it("has one row per student of the roster, accepted or not, with the live counters", async () => {
    const w = await world({ students: 3 });
    const [a, b] = w.students;
    const repo = await repoOf(w, a!.id, { lastCommitSha: "a".repeat(40), lastCommitAt: at(NOW), ciStatus: "pass" });
    // A staff seat never shows; a student who left the roster still shows by their repository.
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: w.classroomId,
      nom: "Staff",
      prenom: "Seat",
      email: `staff-${randomUUID()}@heig.test`,
      userId: teacher.id,
      staff: true,
    });
    const leaver = await server.signIn("student");
    await repoOf(w, leaver.id);
    await server.app.db.insert(githubAccounts).values({ userId: a!.id, githubUserId: nextRepo++, login: "alice-gh" });

    const d = await detail(w.projectId);
    expect(d.rows).toHaveLength(4);
    expect(d.counts).toEqual({ students: 3, accepted: 2, groups: 0, live: 2, frozen: 0, toVerify: 0, alerts: 0 });
    // An individual project: no copy group on any row, no resync owed (M3-16b).
    expect([d.rows.every((r) => r.group === null), d.groupSyncPending]).toEqual([true, false]);
    expect(d.primaryAction).toBe("none");
    expect(d.liveStale).toBe(false);

    const row = rowOf(d, a!.id);
    expect(row.student).toMatchObject({ claimed: true, githubLogin: "alice-gh" });
    expect(row.repo).toMatchObject({
      id: repo,
      provisionStatus: "ok",
      invitationStatus: "accepted",
      // The stored student commit, never GitHub's head (which may be the App's).
      lastCommit: { sha: "a".repeat(40), at: NOW },
      ciStatus: "pass",
      live: { commitCount: 1, checksPassed: 1, checksTotal: 2, stale: false },
      effectiveDeadlineAt: DEADLINE,
      degraded: false,
    });
    expect(rowOf(d, b!.id).repo).toBeNull();
    expect(d.rows.at(-1)!.student).toMatchObject({ enrollmentId: null, userId: leaver.id, claimed: false });
  });

  it("draws the repository of a user who holds a staff seat as a badged test row, counted nowhere (ADR-077)", async () => {
    const w = await world({ students: 1 });
    const student = w.students[0]!;
    await repoOf(w, student.id, { frozenAt: at(NOW), deadlineAppliedAt: at(NOW) });
    const promoted = await server.signIn("student");
    const promotedRepo = await repoOf(w, promoted.id);
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: w.classroomId,
      nom: "Assistant",
      prenom: "Now",
      email: `assistant-${randomUUID()}@heig.test`,
      userId: promoted.id,
      staff: true,
    });

    const d = await detail(w.projectId);
    expect(d.rows.map((r) => [r.student.userId, r.staff])).toEqual([
      [student.id, false],
      [promoted.id, true],
    ]);
    expect(d.rows.find((r) => r.repo?.id === promotedRepo)?.staff).toBe(true);
    expect(d.counts).toMatchObject({ students: 1, accepted: 1, live: 1, frozen: 1 });
  });

  it("counts the student's commits as their own card does (M3-14m): bots and late pushes out, no GitHub call needed", async () => {
    const w = await world({ students: 1 });
    const student = w.students[0]!;
    const repo = await repoOf(w, student.id);
    // A staff seat's test repository counts over its own receipts.
    const promoted = await server.signIn("student");
    const test = await repoOf(w, promoted.id);
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: w.classroomId,
      nom: "Assistant",
      prenom: "Now",
      email: `assistant-${randomUUID()}@heig.test`,
      userId: promoted.id,
      staff: true,
    });
    const gid = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!.githubRepoId!;
    const receipt = async (githubRepoId: number, receivedAt: string, commits: number | null, isBot = false) =>
      server.app.db.insert(pushReceipts).values({
        id: randomUUID(),
        githubRepoId,
        branch: "main",
        headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
        receivedAt: at(receivedAt),
        isBot,
        commits,
      });
    const g = await gid(repo);
    await receipt(g, "2026-10-01T10:00:00Z", 3);
    await receipt(g, "2026-10-02T07:00:00Z", null); // before the count existed: one
    await receipt(g, NOW, 40, true); // the App's or a workflow's
    await receipt(g, "2026-10-10T00:00:00Z", 7); // after the deadline
    await receipt(await gid(test), "2026-10-01T10:00:00Z", 2);

    const studentView = await call(`/app/api/student/projects/${w.projectId}`, student.headers);
    expect(studentView.statusCode, studentView.body).toBe(200);
    const d = await detail(w.projectId);
    expect(rowOf(d, student.id).repo!.commits).toBe(4);
    expect(studentView.json().repo.commits).toBe(rowOf(d, student.id).repo!.commits);
    expect(rowOf(d, promoted.id).repo).toMatchObject({ commits: 2 });

    // The count needs no live state: a rate-limited GitHub changes nothing.
    limitedOrgs.add(w.org);
    resetLiveStateCache();
    const limited = rowOf(await detail(w.projectId), student.id).repo!;
    expect([limited.live, limited.commits]).toEqual([null, 4]);
  });

  it("raises each flag of a repository", async () => {
    const w = await world({ students: 5 });
    const [s1, s2, s3, s4, s5] = w.students;
    const suspended = await repoOf(w, s1!.id, { protectionSuspendedAt: at(NOW) });
    const verified = await repoOf(w, s2!.id);
    const current = await run(verified, "2026-10-02T07:00:00Z", { toVerify: true });
    await setRepo(verified, { currentGradeRunId: current });
    // A run to verify outside the slots (a restored head) flags nothing.
    await run(suspended, "2026-10-02T07:00:00Z", { toVerify: true });
    const alerted = await repoOf(w, s3!.id);
    await run(alerted, "2026-10-01T10:00:00Z", { parseStatus: "multiple", points: null, max: null });
    await run(alerted, "2026-10-01T11:00:00Z", { parseStatus: "malformed", points: null, max: null, parseDetail: "GRADE 8 of 10" });
    await run(alerted, "2026-10-01T12:00:00Z", { afterDeadline: true });
    const deleted = await repoOf(w, s4!.id, { deletedAt: at(NOW) });
    await repoOf(w, s5!.id, { rulesetId: null });

    const d = await detail(w.projectId);
    const flags = (userId: string) => rowOf(d, userId).repo!.flags;
    expect(flags(s1!.id)).toMatchObject({ protectionSuspended: true, toVerify: false });
    expect(flags(s2!.id)).toMatchObject({ toVerify: true, protectionSuspended: false, multiple: false });
    // `malformed` is the latest run's: the last run here was scored.
    expect(flags(s3!.id)).toMatchObject({ multiple: true, malformed: null });
    expect(flags(s4!.id)).toMatchObject({ deleted: true });
    expect(rowOf(d, s5!.id).repo!.degraded).toBe(true);
    expect(d.counts).toMatchObject({ accepted: 5, live: 4, toVerify: 1, alerts: 2 });
    // A deleted repository is never asked about.
    const deletedName = (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, deleted)))[0]!.fullName!;
    expect(liveCalls(`${deletedName}/`)).toBe(0);
    expect(liveCalls(`${w.org}/`)).toBeGreaterThan(0);

    await run(alerted, "2026-10-01T13:00:00Z", { parseStatus: "malformed", points: null, max: null, parseDetail: "GRADE 8 of 10" });
    expect(rowOf(await detail(w.projectId), s3!.id).repo!.flags.malformed).toBe("GRADE 8 of 10");
  });

  it("resolves the final score teacher, else review, else frozen, else current, graded by the project's scale", async () => {
    const w = await world({ students: 4, scale: { kind: "score_is_grade", rounding: "nearest" } });
    const [s1, s2, s3, s4] = w.students;
    const slots = async (userId: string, teacherPoints: number | null, withReview: boolean, withFrozen: boolean) => {
      const repo = await repoOf(w, userId, { teacherPoints, teacherComment: teacherPoints === null ? null : "seen" });
      const current = await run(repo, "2026-10-02T07:00:00Z", { points: 4.5, max: 6 });
      const frozen = withFrozen ? await run(repo, "2026-10-02T06:00:00Z", { points: 7, max: 10 }) : null;
      const review = withReview ? await run(repo, "2026-10-02T06:30:00Z", { kind: "review", points: 3, max: 6 }) : null;
      await setRepo(repo, { currentGradeRunId: current, frozenGradeRunId: frozen, reviewGradeRunId: review });
    };
    await slots(s1!.id, 5.5, true, true);
    await slots(s2!.id, null, true, true);
    await slots(s3!.id, null, false, true);
    await slots(s4!.id, null, false, false);

    const d = await detail(w.projectId);
    const scores = (userId: string) => rowOf(d, userId).repo!.scores;
    expect(scores(s1!.id).final).toEqual({ points: 5.5, max: 6, source: "teacher", toVerify: false, grade: { grade: 5.5, fellBack: false } });
    // A row without its own maximum (heig-classroom's imported ones) reads the review's.
    expect(scores(s1!.id).teacher).toEqual({ points: 5.5, max: null, comment: "seen", gradedAt: null });
    expect(scores(s2!.id).final).toEqual({ points: 3, max: 6, source: "review", toVerify: false, grade: { grade: 3, fellBack: false } });
    // A frozen score out of 10 under "the score is the grade": the linear scale, and says so.
    expect(scores(s3!.id).final).toEqual({ points: 7, max: 10, source: "ci", toVerify: false, grade: { grade: 4.5, fellBack: true } });
    expect(scores(s3!.id).frozen).toMatchObject({ points: 7, max: 10, grade: { grade: 4.5, fellBack: true } });
    expect(scores(s4!.id).final).toEqual({ points: 4.5, max: 6, source: "ci", toVerify: false, grade: { grade: 4.5, fellBack: false } });
    expect(scores(s4!.id).frozen).toBeNull();
    // The maximum a teacher's score is held to, per row: the review's, the frozen run's, the current one's (`teacherRunMax`).
    expect([s1, s2, s3, s4].map((s) => scores(s!.id).scoreMax)).toEqual([6, 6, 10, 6]);
  });

  it("shows a score changed after the release, and offers the release again for it", async () => {
    const w = await world({ students: 2, state: "locked" });
    const [s1, s2] = w.students;
    const frozenAt = at("2026-10-09T22:30:00Z");
    const r1 = await repoOf(w, s1!.id, { deadlineAppliedAt: frozenAt, frozenAt });
    const r2 = await repoOf(w, s2!.id, { deadlineAppliedAt: frozenAt });
    for (const repo of [r1, r2]) await setRepo(repo, { currentGradeRunId: await run(repo, "2026-10-09T20:00:00Z") });

    // Not every live repository frozen: no release yet.
    expect((await detail(w.projectId)).primaryAction).toBe("none");
    await setRepo(r2, { frozenAt });
    const before = await detail(w.projectId);
    expect([before.primaryAction, before.counts.frozen, before.releasedAt]).toEqual(["release", 2, null]);
    expect(rowOf(before, s1!.id).repo!.released).toBeNull();

    await server.app.db.update(projects).set({ releasedAt: at(NOW), releasedBy: teacher.id }).where(eq(projects.id, w.projectId));
    for (const repo of [r1, r2]) await setRepo(repo, { releasedPoints: 8, releasedMax: 10 });
    const released = await detail(w.projectId);
    expect(released.primaryAction).toBe("none");
    expect(rowOf(released, s1!.id).repo!.flags.changedAfterRelease).toBe(false);

    await setRepo(r1, { teacherPoints: 9 });
    const changed = await detail(w.projectId);
    expect(rowOf(changed, s1!.id).repo).toMatchObject({ released: { points: 8, max: 10 }, flags: { changedAfterRelease: true } });
    expect(rowOf(changed, s2!.id).repo!.flags.changedAfterRelease).toBe(false);
    expect(changed.primaryAction).toBe("release");
  });

  it("shows where each repository's final review stands (F-PROJ-11, M3-08b)", async () => {
    const w = await world({ students: 6, state: "locked" });
    const [open, noRun, suspended, claimed, asked, done] = w.students;
    const frozenAt = at("2026-10-09T22:30:00Z");
    const frozen = { deadlineAppliedAt: frozenAt, frozenAt };
    await repoOf(w, open!.id);
    await repoOf(w, noRun!.id, frozen);
    const withRun = async (userId: string, patch: RepoPatch = {}) => {
      const repo = await repoOf(w, userId, { ...frozen, ...patch });
      await setRepo(repo, { frozenGradeRunId: await run(repo, "2026-10-09T20:00:00Z") });
      return repo;
    };
    await withRun(suspended!.id, { protectionSuspendedAt: frozenAt });
    const sha = "c".repeat(40);
    const dispatch = (repoId: string, dispatchedAt: Date | null) =>
      server.app.db.insert(gradeDispatches).values({ id: randomUUID(), repoId, trigger: "deadline", sha, dispatchedAt, createdAt: frozenAt });
    await dispatch(await withRun(claimed!.id), null);
    await dispatch(await withRun(asked!.id), at("2026-10-09T22:31:00Z"));
    const reviewed = await withRun(done!.id);
    const review = await run(reviewed, "2026-10-09T23:00:00Z", { kind: "review", points: 5, max: 6 });
    await setRepo(reviewed, { reviewGradeRunId: review });
    await dispatch(reviewed, at("2026-10-09T22:31:00Z"));

    const d = await detail(w.projectId);
    const state = (userId: string) => rowOf(d, userId).repo!.review;
    const none = { reason: null, askedAt: null, sha: null, runId: null };
    expect(state(open!.id)).toEqual({ ...none, status: "pending" });
    expect(state(noRun!.id)).toEqual({ ...none, status: "none", reason: "no_frozen_run" });
    expect(state(suspended!.id)).toEqual({ ...none, status: "skipped", reason: "protection_suspended" });
    expect(state(claimed!.id)).toEqual({ ...none, status: "unconfirmed", sha });
    expect(state(asked!.id)).toEqual({ ...none, status: "asked", sha, askedAt: "2026-10-09T22:31:00.000Z" });
    expect(state(done!.id)).toEqual({ status: "done", reason: null, sha, askedAt: "2026-10-09T22:31:00.000Z", runId: review });

    // Archived as its lock: skipped too; an ungraded project: none, whatever the rows.
    await setRepo(rowOf(d, suspended!.id).repo!.id, { protectionSuspendedAt: null, archivedAt: frozenAt });
    expect(rowOf(await detail(w.projectId), suspended!.id).repo!.review).toMatchObject({ status: "skipped", reason: "archived" });
    await server.app.db.update(projects).set({ gradingMode: "none" }).where(eq(projects.id, w.projectId));
    expect(rowOf(await detail(w.projectId), noRun!.id).repo!.review).toEqual({ ...none, status: "none" });
  });

  it("publishes a draft; a deleted repository does not hold the release back", async () => {
    const draft = await world({ students: 1, state: "draft" });
    expect((await detail(draft.projectId)).primaryAction).toBe("publish");

    const w = await world({ students: 2, state: "locked" });
    await repoOf(w, w.students[0]!.id, { frozenAt: at(NOW), deadlineAppliedAt: at(NOW) });
    await repoOf(w, w.students[1]!.id, { deletedAt: at(NOW) });
    expect((await detail(w.projectId)).primaryAction).toBe("release");
    await server.app.db.update(projects).set({ gradingMode: "none" }).where(eq(projects.id, w.projectId));
    expect((await detail(w.projectId)).primaryAction).toBe("none");
  });
});

describe("the live state never holds the page (N-PERF-07)", () => {
  it("answers a rate-limited cold read with the stored state at once, and asks GitHub no more", async () => {
    const w = await world({ students: 2 });
    for (const s of w.students) await repoOf(w, s.id, { ciStatus: "fail", lastCommitSha: "c".repeat(40) });
    limitedOrgs.add(w.org);
    const first = await detail(w.projectId);
    expect(first.rows.map((r) => [r.repo!.live, r.repo!.ciStatus])).toEqual([
      [null, "fail"],
      [null, "fail"],
    ]);
    expect(liveCalls(`${w.org}/`)).toBeGreaterThan(0);
    // The installation is skipped until GitHub's reset: not one more request, not even a token.
    const calls = gh.calls.length;
    await detail(w.projectId);
    expect(gh.calls.length).toBe(calls);
  });

  it("answers within its budget when GitHub is slow, marked stale", async () => {
    const w = await world({ students: 2 });
    const [slow, quick] = w.students;
    await repoOf(w, slow!.id);
    await repoOf(w, quick!.id);
    const project = (await server.app.db.select().from(projects).where(eq(projects.id, w.projectId)))[0]!;
    const slowName = (await server.app.db.select().from(projectRepos).where(eq(projectRepos.userId, slow!.id)))[0]!.fullName!;
    hanging.add(slowName);
    const started = Date.now();
    const d = await projectDetail(server.app.db, config, project, server.clock.now(), { log: server.app.log, budgetMs: 200 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(d.liveStale).toBe(true);
    expect(rowOf(d, slow!.id).repo!.live).toBeNull();
  });
});

describe("a repository's runs", () => {
  it("lists them newest first and names the current, frozen and review runs", async () => {
    const w = await world({ students: 1 });
    const repo = await repoOf(w, w.students[0]!.id);
    const frozen = await run(repo, "2026-10-01T10:00:00Z");
    const review = await run(repo, "2026-10-01T11:00:00Z", { kind: "review" });
    const current = await run(repo, "2026-10-01T12:00:00Z");
    const late = await run(repo, "2026-10-01T13:00:00Z", { afterDeadline: true, parseStatus: "malformed", points: null, max: null, parseDetail: "bad" });
    await setRepo(repo, { currentGradeRunId: current, frozenGradeRunId: frozen, reviewGradeRunId: review });

    const res = await call(`/app/api/projects/${w.projectId}/repos/${repo}/runs`, teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const list = GradeRunList.parse(res.json());
    expect(list).toMatchObject({ currentGradeRunId: current, frozenGradeRunId: frozen, reviewGradeRunId: review });
    expect(list.runs.map((r) => r.id)).toEqual([late, current, review, frozen]);
    expect(list.runs[0]).toMatchObject({ kind: "ci", afterDeadline: true, parseStatus: "malformed", parseDetail: "bad", points: null });
    expect(list.runs[2]!.kind).toBe("review");
    // No GitHub call for the history.
    expect(liveCalls(`${w.org}/`)).toBe(0);
  });
});

describe("staff only (N-SEC-20, invariant 6)", () => {
  it("answers a student, another teacher, an impersonation and a token as nobody", async () => {
    const w = await world({ students: 1 });
    const student = w.students[0]!;
    const repo = await repoOf(w, student.id);
    const stranger = await server.signIn("teacher");
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "t", expiresInDays: null });
    const s = await createSession(server.app.db, teacher.id, 8, {
      kind: "impersonation",
      actorUserId: (await server.signIn("admin")).id,
      evaluationId: null,
      projectId: null,
    });
    const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    const callers: [string, Headers][] = [
      ["student", student.headers],
      ["stranger", stranger.headers],
      ["impersonation", impersonation],
      ["token", { authorization: `Bearer ${token}` }],
    ];
    for (const url of [`/app/api/projects/${w.projectId}`, `/app/api/projects/${w.projectId}/repos/${repo}/runs`]) {
      for (const [who, headers] of callers) {
        const res = await call(url, headers);
        expect([res.statusCode, res.json().error], `${who} ${url}`).toEqual([404, "not_found"]);
      }
    }
    // Another project's repository is as missing as none.
    const other = await world({ students: 1 });
    const res = await call(`/app/api/projects/${other.projectId}/repos/${repo}/runs`, teacher.headers);
    expect(res.statusCode).toBe(404);
  });
});
