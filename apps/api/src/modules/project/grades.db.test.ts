/**
 * The teacher's score and the release (merge task M3-08b, F-PROJ-14,
 * F-GRADE-09, D05) on a server built with Quiz's App against the fake
 * GitHub; the rows written directly, as the pipeline leaves them. The
 * product owner's decisions of 2026-10-02:
 *
 * - a score after the definitive freeze only, on a graded project; its
 *   maximum the scored run's (a given one must equal it), or its own,
 *   required, without a scored run; the points within it; null clears it;
 * - the release once every LIVE repository is frozen for good — a
 *   repository with a later own deadline holds it back, a deleted or
 *   never-provisioned one does not —, a snapshot per repository, a release
 *   again rewriting it, "changed after release" through the page;
 * - staff only (invariant 6): a student, another teacher, an
 *   impersonation, a token get the 404 of a missing project.
 */
import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDetail, ProjectReleaseResult, ProjectRepoScores } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { auditLog, courseStaff, enrollments, githubOrganizations, projectGradeRuns, projectRepos, projects } from "../../db/schema.js";
import { resetLiveStateCache } from "../../github/metrics.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { accessibleProject, accessibleProjectRepo } from "../guards.js";

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
const FROZEN_AT = "2026-10-09T22:30:00.000Z";
const at = (iso: string) => new Date(iso);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 52_000;
let nextRepo = 50_000;

/** The live state of any repository: one commit, one check passed. */
const liveRoute: Route = (url, req) => {
  if (url.host !== "api.github.com" || req.method !== "GET") return undefined;
  const m = /^\/repos\/[^/]+\/[^/]+\/commits(\/[^/]+\/check-runs)?$/.exec(url.pathname);
  if (!m) return undefined;
  if (m[1]) return json({ check_runs: [{ status: "completed", conclusion: "success" }] });
  return json([{ sha: "b".repeat(40), commit: { committer: { date: NOW } } }]);
};

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

interface World {
  projectId: string;
  classroomId: string;
  courseId: string;
  students: { id: string; headers: Headers }[];
}

/** A locked, graded project past its deadline, of `students` claimed students; no repository yet. */
async function world(opts: { students?: number; gradingMode?: "auto" | "none" } = {}): Promise<World> {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => server.signIn("student")));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
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
    gradingMode: opts.gradingMode ?? "auto",
    gradingScale: { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
  });
  return { projectId, classroomId: seeded.classroomId, courseId: seeded.courseId, students };
}

type RepoPatch = Partial<typeof projectRepos.$inferInsert>;
/** The student's repository, provisioned and frozen for good unless `patch` says otherwise. */
async function repoOf(w: World, userId: string, patch: RepoPatch = {}): Promise<string> {
  const id = randomUUID();
  const n = nextRepo++;
  await server.app.db.insert(projectRepos).values({
    id,
    projectId: w.projectId,
    userId,
    githubRepoId: n,
    fullName: `gorg/lab-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: at("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    rulesetId: n,
    deadlineAppliedAt: at(DEADLINE),
    frozenAt: at(FROZEN_AT),
    ...patch,
  });
  return id;
}

type RunPatch = Partial<typeof projectGradeRuns.$inferInsert>;
/** A stored run of the repository: a scored `ci` run 7/10 unless `patch` says otherwise. */
async function run(repoId: string, patch: RunPatch = {}): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(projectGradeRuns).values({
    id,
    repoId,
    workflowRunId: Math.floor(Math.random() * 1e9),
    headBranch: "main",
    headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    conclusion: "success",
    points: 7,
    max: 10,
    parseStatus: "ok",
    completedAt: at("2026-10-09T20:00:00Z"),
    ...patch,
  });
  return id;
}

const setRepo = (id: string, patch: RepoPatch) => server.app.db.update(projectRepos).set(patch).where(eq(projectRepos.id, id));
const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const projectRow = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));

const score = (w: World, repo: string, body: object, headers = teacher.headers) =>
  call("PATCH", `/app/api/projects/${w.projectId}/repos/${repo}/score`, headers, body);
const release = (w: World, headers = teacher.headers) => call("POST", `/app/api/projects/${w.projectId}/release`, headers);
async function detail(w: World): Promise<ProjectDetail> {
  const res = await call("GET", `/app/api/projects/${w.projectId}`, teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectDetail.parse(res.json());
}
const rowOf = (d: ProjectDetail, userId: string) => d.rows.find((r) => r.student.userId === userId)!.repo!;

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), liveRoute];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  resetLiveStateCache();
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

describe("the teacher's score (F-PROJ-14)", () => {
  it("waits for the definitive freeze and a graded project", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id, { frozenAt: null });
    const early = await score(w, repo, { points: 8 });
    expect([early.statusCode, early.json().error]).toEqual([409, "not_frozen"]);

    await setRepo(repo, { frozenAt: at(FROZEN_AT) });
    await server.app.db.update(projects).set({ gradingMode: "none" }).where(eq(projects.id, w.projectId));
    const ungraded = await score(w, repo, { points: 8 });
    expect([ungraded.statusCode, ungraded.json().error]).toEqual([409, "grading_none"]);
  });

  it("takes the scored run's maximum, refuses another one and points above it", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    await setRepo(repo, { frozenGradeRunId: await run(repo), currentGradeRunId: await run(repo, { points: 9, max: 20 }) });

    const mismatch = await score(w, repo, { points: 8, max: 12 });
    expect([mismatch.statusCode, mismatch.json().error]).toEqual([422, "score_max_mismatch"]);
    const above = await score(w, repo, { points: 11 });
    expect([above.statusCode, above.json().error]).toEqual([422, "score_above_max"]);
    expect((await score(w, repo, { points: 1001 })).statusCode).toBe(400);
    expect((await score(w, repo, { points: -1 })).statusCode).toBe(400);
    expect((await score(w, repo, { points: 8, extra: 1 })).statusCode).toBe(400);

    const res = await score(w, repo, { points: 8, comment: "Late fixes counted" });
    expect(res.statusCode, res.body).toBe(200);
    const scores = ProjectRepoScores.parse(res.json());
    // The FROZEN run's maximum (10), never the current one's (20) — and the page is told which (`scoreMax`).
    expect(scores.scores.teacher).toEqual({ points: 8, max: 10, comment: "Late fixes counted", gradedAt: NOW });
    expect(scores.scores.scoreMax).toBe(10);
    expect(scores.scores.final).toEqual({ points: 8, max: 10, source: "teacher", toVerify: false, grade: { grade: 5, fellBack: false } });
    expect(scores).toMatchObject({ released: null, changedAfterRelease: false });
    expect(await repoRow(repo)).toMatchObject({ teacherPoints: 8, teacherMax: 10, teacherGradedBy: teacher.id, teacherGradedAt: at(NOW) });
    // The same maximum given is accepted.
    expect((await score(w, repo, { points: 10, max: 10 })).statusCode).toBe(200);
    expect(rowOf(await detail(w), w.students[0]!.id).scores.teacher).toMatchObject({ points: 10, max: 10, comment: null });
  });

  it("reads the review's maximum when the review slot is filled", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    await setRepo(repo, { frozenGradeRunId: await run(repo), reviewGradeRunId: await run(repo, { kind: "review", points: 3, max: 6 }) });
    const mismatch = await score(w, repo, { points: 5, max: 10 });
    expect([mismatch.statusCode, mismatch.json().error]).toEqual([422, "score_max_mismatch"]);
    const res = await score(w, repo, { points: 5, max: 6 });
    expect(res.statusCode, res.body).toBe(200);
    const scores = ProjectRepoScores.parse(res.json()).scores;
    expect(scores.final).toMatchObject({ points: 5, max: 6, source: "teacher" });
    expect(scores.scoreMax).toBe(6);
  });

  it("requires the teacher's own maximum without a scored run, and grades with it", async () => {
    const w = await world({ students: 2 });
    const [bare, failed] = w.students;
    const noRun = await repoOf(w, bare!.id, { ciStatus: "pass" });
    const malformed = await repoOf(w, failed!.id);
    await setRepo(malformed, { frozenGradeRunId: await run(malformed, { parseStatus: "malformed", points: null, max: null, parseDetail: "GRADE 8 of 10" }) });

    for (const repo of [noRun, malformed]) {
      const missing = await score(w, repo, { points: 8 });
      expect([missing.statusCode, missing.json().error]).toEqual([422, "score_max_required"]);
      const above = await score(w, repo, { points: 21, max: 20 });
      expect([above.statusCode, above.json().error]).toEqual([422, "score_above_max"]);
      const res = await score(w, repo, { points: 8, max: 20 });
      expect(res.statusCode, res.body).toBe(200);
      const scores = ProjectRepoScores.parse(res.json()).scores;
      expect(scores.final).toEqual({
        points: 8,
        max: 20,
        source: "teacher",
        toVerify: false,
        grade: { grade: 3, fellBack: false },
      });
      // No scored run to hold the score to: the page shows the maximum field.
      expect(scores.scoreMax).toBeNull();
    }
    expect(await repoRow(noRun)).toMatchObject({ teacherPoints: 8, teacherMax: 20 });
  });

  it("treats a run to verify as no scored run: the teacher gives their own maximum", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    await setRepo(repo, { frozenGradeRunId: await run(repo, { toVerify: true }) });
    expect(rowOf(await detail(w), w.students[0]!.id).scores.scoreMax).toBeNull();
    const missing = await score(w, repo, { points: 8 });
    expect([missing.statusCode, missing.json().error]).toEqual([422, "score_max_required"]);
    const res = await score(w, repo, { points: 8, max: 20 });
    expect(res.statusCode, res.body).toBe(200);
    const scores = ProjectRepoScores.parse(res.json()).scores;
    expect(scores.final).toMatchObject({ points: 8, max: 20, source: "teacher", toVerify: false });
    expect(scores.scoreMax).toBeNull();
  });

  it("clears the score with null, and audits before and after", async () => {
    const w = await world();
    const repo = await repoOf(w, w.students[0]!.id);
    await setRepo(repo, { frozenGradeRunId: await run(repo) });
    expect((await score(w, repo, { points: 8, comment: "seen" })).statusCode).toBe(200);
    const res = await score(w, repo, { points: null });
    expect(res.statusCode, res.body).toBe(200);
    const scores = ProjectRepoScores.parse(res.json());
    expect(scores.scores.teacher).toBeNull();
    expect(scores.scores.final).toMatchObject({ points: 7, max: 10, source: "ci" });
    expect(await repoRow(repo)).toMatchObject({ teacherPoints: null, teacherMax: null, teacherComment: null, teacherGradedBy: null, teacherGradedAt: null });

    const entries = await auditOf(repo, "project_repo.grade_override");
    expect(entries.map((e) => e.payload)).toEqual([
      { before: null, after: { points: 8, max: 10, comment: "seen" } },
      { before: { points: 8, max: 10, comment: "seen" }, after: null },
    ]);
    expect(entries[0]!.actorUserId).toBe(teacher.id);
  });
});

describe("the release (F-PROJ-14, D05)", () => {
  it("is the course owner's: an assistant gets 403 owner_required, and nothing is released (ADR-068)", async () => {
    const w = await world();
    await repoOf(w, w.students[0]!.id);
    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: w.courseId, userId: assistant.id, role: "assistant" });
    const res = await release(w, assistant.headers);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: "owner_required" });
    expect((await projectRow(w.projectId)).releasedAt).toBeNull();
    expect((await release(w)).statusCode).toBe(200);
  });

  it("waits until every live repository is frozen: one with a later own deadline holds it back", async () => {
    const w = await world({ students: 2 });
    const [a, b] = w.students;
    await repoOf(w, a!.id);
    const extended = await repoOf(w, b!.id, { deadlineAt: at("2026-10-12T22:00:00Z"), deadlineAppliedAt: null, frozenAt: null });
    const res = await release(w);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_frozen", live: 2, frozen: 1 });
    expect((await projectRow(w.projectId)).releasedAt).toBeNull();

    await setRepo(extended, { deadlineAppliedAt: at("2026-10-12T22:00:00Z"), frozenAt: at("2026-10-12T22:30:00Z") });
    expect((await release(w)).statusCode).toBe(200);
  });

  it("waits for the teacher's score where a final score rests on a run to verify (F-PROJ-08)", async () => {
    const w = await world({ students: 2 });
    const [suspect, plain] = w.students;
    const tampered = await repoOf(w, suspect!.id);
    await setRepo(tampered, { frozenGradeRunId: await run(tampered, { toVerify: true }) });
    const clean = await repoOf(w, plain!.id);
    await setRepo(clean, { frozenGradeRunId: await run(clean) });

    const before = await detail(w);
    expect(before.primaryAction).toBe("none");
    expect(rowOf(before, suspect!.id).scores.final).toMatchObject({ source: "ci", toVerify: true });
    expect(rowOf(before, plain!.id).scores.final).toMatchObject({ source: "ci", toVerify: false });
    const refused = await release(w);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "to_verify", repos: [tampered] });
    expect((await projectRow(w.projectId)).releasedAt).toBeNull();

    // The teacher's score settles it (the run's maximum does not apply: its own).
    expect((await score(w, tampered, { points: 5, max: 10 })).statusCode).toBe(200);
    expect((await detail(w)).primaryAction).toBe("release");
    const res = await release(w);
    expect(res.statusCode, res.body).toBe(200);
    expect(await repoRow(tampered)).toMatchObject({ releasedPoints: 5, releasedMax: 10 });
  });

  it("never waits for a deleted, unfrozen repository's score to verify: released as no score", async () => {
    const w = await world({ students: 2 });
    const [gone, plain] = w.students;
    // Deleted on GitHub before its deadline: it never freezes, the teacher can never score it.
    const deleted = await repoOf(w, gone!.id, { deletedAt: at(NOW), deadlineAppliedAt: null, frozenAt: null });
    await setRepo(deleted, { currentGradeRunId: await run(deleted, { toVerify: true }) });
    const clean = await repoOf(w, plain!.id);
    await setRepo(clean, { frozenGradeRunId: await run(clean) });

    const before = await detail(w);
    expect(before.primaryAction).toBe("release");
    expect(rowOf(before, gone!.id).scores.final).toMatchObject({ source: "ci", toVerify: true });
    const res = await release(w);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectReleaseResult.parse(res.json())).toMatchObject({ repos: 2, scored: 1 });
    expect(await repoRow(deleted)).toMatchObject({ releasedPoints: null, releasedMax: null });
    expect(await repoRow(clean)).toMatchObject({ releasedPoints: 7, releasedMax: 10 });

    // The live score is still shown to verify, but is not "changed after release": no Release offered again.
    const after = await detail(w);
    expect(rowOf(after, gone!.id)).toMatchObject({
      scores: { final: { toVerify: true } },
      released: { points: null, max: null },
      flags: { changedAfterRelease: false, deleted: true },
    });
    expect(after.primaryAction).toBe("none");
  });

  it("is refused on an ungraded project, and without a single live repository", async () => {
    const none = await world({ gradingMode: "none" });
    await repoOf(none, none.students[0]!.id);
    const ungraded = await release(none);
    expect([ungraded.statusCode, ungraded.json().error]).toEqual([409, "grading_none"]);

    const empty = await world();
    const nothing = await release(empty);
    expect([nothing.statusCode, nothing.json().error]).toEqual([409, "not_frozen"]);
  });

  it("writes a snapshot per repository — deleted and never-provisioned ones included, never blocking", async () => {
    const w = await world({ students: 4 });
    const [s1, s2, s3, s4] = w.students;
    const frozenRepo = await repoOf(w, s1!.id);
    await setRepo(frozenRepo, { frozenGradeRunId: await run(frozenRepo) });
    const overridden = await repoOf(w, s2!.id, { teacherPoints: 9, teacherMax: 20 });
    // Deleted before its freeze, with a current score: no freeze will come, it does not block.
    const deleted = await repoOf(w, s3!.id, { deletedAt: at(NOW), deadlineAppliedAt: null, frozenAt: null });
    await setRepo(deleted, { currentGradeRunId: await run(deleted, { points: 2, max: 10 }) });
    const pending = await repoOf(w, s4!.id, {
      provisionStatus: "pending",
      githubRepoId: null,
      fullName: null,
      deadlineAppliedAt: null,
      frozenAt: null,
    });

    const res = await release(w);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectReleaseResult.parse(res.json())).toEqual({ releasedAt: NOW, first: true, repos: 4, scored: 3 });
    expect(await projectRow(w.projectId)).toMatchObject({ releasedAt: at(NOW), releasedBy: teacher.id });
    expect(await repoRow(frozenRepo)).toMatchObject({ releasedPoints: 7, releasedMax: 10 });
    expect(await repoRow(overridden)).toMatchObject({ releasedPoints: 9, releasedMax: 20 });
    expect(await repoRow(deleted)).toMatchObject({ releasedPoints: 2, releasedMax: 10 });
    expect(await repoRow(pending)).toMatchObject({ releasedPoints: null, releasedMax: null });
    const [entry] = await auditOf(w.projectId, "project.release");
    expect(entry!.payload).toEqual({ first: true, repos: 4, scored: 3 });

    const d = await detail(w);
    expect(d.releasedAt).toBe(NOW);
    expect(d.primaryAction).toBe("none");
    expect(rowOf(d, s1!.id)).toMatchObject({ released: { points: 7, max: 10 }, flags: { changedAfterRelease: false } });
    expect(rowOf(d, s4!.id)).toMatchObject({ released: { points: null, max: null }, flags: { changedAfterRelease: false } });
  });

  it("shows a score changed after the release, and a release again rewrites the snapshot without a first", async () => {
    const w = await world();
    const student = w.students[0]!;
    const repo = await repoOf(w, student.id);
    await setRepo(repo, { frozenGradeRunId: await run(repo) });
    expect((await release(w)).statusCode).toBe(200);

    const changed = await score(w, repo, { points: 9 });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(ProjectRepoScores.parse(changed.json())).toMatchObject({ released: { points: 7, max: 10 }, changedAfterRelease: true });
    const before = await detail(w);
    expect(rowOf(before, student.id).flags.changedAfterRelease).toBe(true);
    expect(before.primaryAction).toBe("release");

    server.clock.set("2026-10-10T09:00:00.000Z");
    const again = await release(w);
    expect(again.statusCode, again.body).toBe(200);
    expect(ProjectReleaseResult.parse(again.json())).toEqual({ releasedAt: "2026-10-10T09:00:00.000Z", first: false, repos: 1, scored: 1 });
    expect(await repoRow(repo)).toMatchObject({ releasedPoints: 9, releasedMax: 10 });
    const after = await detail(w);
    expect(rowOf(after, student.id)).toMatchObject({ released: { points: 9, max: 10 }, flags: { changedAfterRelease: false } });
    expect(after.primaryAction).toBe("none");
    expect((await auditOf(w.projectId, "project.release")).map((e) => (e.payload as { first: boolean }).first)).toEqual([true, false]);
  });

  it("leaves out the repository of a user who now holds a staff seat", async () => {
    const w = await world({ students: 1 });
    await repoOf(w, w.students[0]!.id);
    const promoted = await server.signIn("student");
    await repoOf(w, promoted.id, { frozenAt: null, deadlineAppliedAt: null });
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: w.classroomId,
      nom: "Assistant",
      prenom: "Now",
      email: `assistant-${randomUUID()}@heig.test`,
      userId: promoted.id,
      staff: true,
    });
    const res = await release(w);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectReleaseResult.parse(res.json())).toMatchObject({ repos: 1 });
  });
});

describe("staff only (invariant 6)", () => {
  it("answers a student, another teacher, an impersonation and a token as nobody", async () => {
    const w = await world();
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
    // An impersonation is read-only outside development (ADR-034 §4): the hook's 403 comes first ...
    const callers: [string, Headers, [number, string]][] = [
      ["student", student.headers, [404, "not_found"]],
      ["stranger", stranger.headers, [404, "not_found"]],
      ["impersonation", impersonation, [403, "impersonation_read_only"]],
      ["token", { authorization: `Bearer ${token}` }, [404, "not_found"]],
    ];
    for (const [who, headers, expected] of callers) {
      const scored = await score(w, repo, { points: 8 }, headers);
      expect([scored.statusCode, scored.json().error], `${who} score`).toEqual(expected);
      const released = await release(w, headers);
      expect([released.statusCode, released.json().error], `${who} release`).toEqual(expected);
    }
    // ... and the loaders answer its 404 where an impersonation may write.
    const sent: unknown[] = [];
    const reply = { code: (status: number) => ({ send: (body: unknown) => sent.push([status, body]) }) } as unknown as FastifyReply;
    const req = { auth: { kind: "impersonation", actorUserId: teacher.id }, caller: { id: teacher.id, role: "teacher", reach: "seats" } };
    expect(await accessibleProject(server.app, req as unknown as FastifyRequest, reply, { id: w.projectId })).toBeNull();
    expect(await accessibleProjectRepo(server.app, req as unknown as FastifyRequest, reply, { id: w.projectId, rid: repo })).toBeNull();
    expect(sent).toEqual([
      [404, { error: "not_found" }],
      [404, { error: "not_found" }],
    ]);
    expect(await repoRow(repo)).toMatchObject({ teacherPoints: null });
    expect((await projectRow(w.projectId)).releasedAt).toBeNull();
    // Another project's repository is as missing as none.
    const other = await world();
    const res = await score(other, repo, { points: 8 });
    expect(res.statusCode).toBe(404);
  });
});
