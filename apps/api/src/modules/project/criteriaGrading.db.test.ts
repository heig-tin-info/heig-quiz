/**
 * The teacher's grading screen of a project graded by criteria (ADR-106
 * §7, §8; L-02e) on a server built with Quiz's App against the fake
 * GitHub, the rows written directly or through the one writer, as the
 * passes leave them:
 *
 * - the screen's payload, a rationale carried as the text it is;
 * - a teacher's points: a `manual` row still proposed, within the
 *   criterion's range, after the definitive freeze; audited;
 * - Validate and *Validate the rest*: refused while a teacher-only
 *   criterion has no row, naming the repositories and criteria; audited;
 * - the `criteria` final-score source, empty until validated (the final
 *   score falls through), released like any other source;
 * - the release refused while a live student repository is not validated,
 *   a staff test repository excepted;
 * - staff only: an outsider gets the 404 of a missing project. The writes'
 *   course-role refusal (`403`) cannot be exercised here: every member of
 *   a course's staff is an owner or an assistant, and either may grade.
 */
import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PointsOutOfRange, ProjectDetail, ProjectGradingRepo, ProjectGradingView, ProjectValidated } from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { auditLog, courseStaff, enrollments, githubOrganizations, projectCriteria, projectCriterionGrades, projectGradeRuns, projectRepos, projects } from "../../db/schema.js";
import { resetLiveStateCache } from "../../github/metrics.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { writeCriterionGrades } from "./criterionGrades.js";

const CRITERIA = `schema_version: 2
grading:
  context: "Labo"
  sources: []
criteria:
  rendu:
    all-tests-passed: {description: Tests, awarded_points: 0, max_points: 10}
  rapport:
    style: {description: Style, awarded_points: 0, max_points: 4, prompt: "Well written?"}
    crash: {description: Crash penalty, awarded_points: 0, max_points: -2, prompt: "Does it crash?"}
    extra: {description: Extra mile, awarded_points: 0, bonus_points: 1, prompt: "Beyond the lab?"}
  git:
    commits: {description: Who committed the work, awarded_points: 0, max_points: 2}
`;
const MACHINE = ["rendu.all-tests-passed", "rapport.style", "rapport.crash", "rapport.extra"];
const XSS = "<script>alert(1)</script>";

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
let nextOrg = 61_000;
let nextRepo = 61_000;

const call = (method: "GET" | "POST" | "PUT", url: string, headers: Headers = teacher.headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

interface World {
  projectId: string;
  classroomId: string;
  courseId: string;
  students: { id: string; headers: Headers }[];
}

/** A locked project graded by criteria, past its deadline, with its snapshot; no repository yet. */
async function world(students = 2): Promise<World> {
  const db = server.app.db;
  const people = await Promise.all(Array.from({ length: students }, () => server.signIn("student")));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: people.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `corg-${n}`, githubOrgId: n, installationId: n });
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
    sourceFullName: `corg-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `corg-${n}/lab-squashed`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "criteria",
    gradingScale: { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
  });
  const parsed = parseCriteria(CRITERIA, { version: 2 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db.insert(projectCriteria).values({ projectId, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  return { projectId, classroomId: seeded.classroomId, courseId: seeded.courseId, students: people };
}

/** The repository of `userId`, provisioned and frozen for good unless `patch` says otherwise. */
async function repoOf(w: World, userId: string, patch: Partial<typeof projectRepos.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  const n = nextRepo++;
  await server.app.db.insert(projectRepos).values({
    id,
    projectId: w.projectId,
    userId,
    githubRepoId: n,
    fullName: `corg/lab-${n}`,
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

/** The machine's proposals of a pass: tests 8/10, style 3/4 with a rationale, no crash, the bonus. */
async function proposals(repoId: string) {
  const pass = randomUUID();
  const auto = { source: "auto" as const, state: "proposed" as const, passId: pass };
  const llm = { source: "llm" as const, state: "proposed" as const, passId: pass };
  await writeCriterionGrades(
    server.app.db,
    repoId,
    [
      { criterionId: "rendu.all-tests-passed", points: 8, max: 10, ...auto },
      { criterionId: "rapport.style", points: 3, max: 4, rationale: XSS, ...llm },
      { criterionId: "rapport.crash", points: 0, max: -2, rationale: "No crash.", ...llm },
      { criterionId: "rapport.extra", points: 1, max: 0, rationale: "A test of its own.", ...llm },
    ],
    at(FROZEN_AT),
  );
}

/** A scored CI run 6/10, frozen: what the final score falls through to. */
async function frozenRun(repoId: string) {
  const id = randomUUID();
  await server.app.db.insert(projectGradeRuns).values({
    id,
    repoId,
    workflowRunId: Math.floor(Math.random() * 1e9),
    headBranch: "main",
    headSha: "a".repeat(40),
    conclusion: "success",
    points: 6,
    max: 10,
    parseStatus: "ok",
    completedAt: at("2026-10-09T20:00:00Z"),
  });
  await server.app.db.update(projectRepos).set({ frozenGradeRunId: id }).where(eq(projectRepos.id, repoId));
}

const gradingUrl = (w: World) => `/app/api/projects/${w.projectId}/grading`;
const criterionUrl = (w: World, repo: string, criterion: string) => `/app/api/projects/${w.projectId}/repos/${repo}/criteria/${criterion}`;
const validateUrl = (w: World, repo: string) => `/app/api/projects/${w.projectId}/repos/${repo}/validate`;

async function grading(w: World): Promise<ProjectGradingView> {
  const res = await call("GET", gradingUrl(w));
  expect(res.statusCode, res.body).toBe(200);
  return ProjectGradingView.parse(res.json());
}
async function detail(w: World): Promise<ProjectDetail> {
  const res = await call("GET", `/app/api/projects/${w.projectId}`);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectDetail.parse(res.json());
}
const repoView = (d: ProjectDetail, repoId: string) => d.rows.find((r) => r.repo?.id === repoId)!.repo!;
const standing = (repoId: string) =>
  server.app.db
    .select()
    .from(projectCriterionGrades)
    .where(and(eq(projectCriterionGrades.repoId, repoId), ne(projectCriterionGrades.state, "superseded")));
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
/** The teacher-only criterion written by a teacher, 0 included. */
const commits = (w: World, repo: string, points = 0) => call("PUT", criterionUrl(w, repo, "git.commits"), teacher.headers, { points });

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => [])];
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

describe("the grading screen's payload (ADR-106 §8)", () => {
  it("lists the criteria with their kind and every live student repository with its table, a rationale as plain text", async () => {
    const w = await world();
    const [a, b] = w.students;
    const graded = await repoOf(w, a!.id);
    await proposals(graded);
    const open = await repoOf(w, b!.id, { frozenAt: null, deadlineAppliedAt: null });
    // A staff seat's test repository (ADR-077) and a deleted one are not graded.
    const staffer = await server.signIn("teacher");
    await server.app.db.insert(enrollments).values({ id: randomUUID(), classroomId: w.classroomId, nom: "T", prenom: "T", email: `t-${randomUUID()}@heig.test`, userId: staffer.id, staff: true });
    await repoOf(w, staffer.id);
    await repoOf(w, (await server.signIn("student")).id, { deletedAt: at(NOW) });

    const view = await grading(w);
    expect(view.repos[0]!.table.map((r) => r.criterionId)).toEqual([...MACHINE, "git.commits"]);
    expect(view.repos.map((r) => r.id).sort()).toEqual([graded, open].sort());
    const entry = view.repos.find((r) => r.id === graded)!;
    expect(entry).toMatchObject({ frozen: true, total: null, evidence: null, validation: { validated: false, missing: ["git.commits"], proposed: MACHINE } });
    expect(entry.table.find((r) => r.criterionId === "rapport.style")).toMatchObject({ points: 3, state: "proposed", source: "llm", rationale: XSS });
    expect(view.repos.find((r) => r.id === open)).toMatchObject({ frozen: false, validation: { missing: [...MACHINE, "git.commits"] } });
  });

  it("is refused off the criteria mode, and to an outsider as a missing project", async () => {
    const w = await world(1);
    const stranger = await server.signIn("teacher");
    expect((await call("GET", gradingUrl(w), stranger.headers)).statusCode).toBe(404);
    expect((await call("GET", gradingUrl(w), w.students[0]!.headers)).statusCode).toBe(404);
    await server.app.db.update(projects).set({ gradingMode: "auto" }).where(eq(projects.id, w.projectId));
    const off = await call("GET", gradingUrl(w));
    expect([off.statusCode, off.json().error]).toEqual([409, "not_criteria"]);
  });
});

describe("a teacher's points (PUT …/criteria/:criterionId)", () => {
  it("writes a manual row, still proposed, within the criterion's range, after the freeze; audited", async () => {
    const w = await world(1);
    const repo = await repoOf(w, w.students[0]!.id);
    await proposals(repo);

    const unknown = await call("PUT", criterionUrl(w, repo, "nope"), teacher.headers, { points: 1 });
    expect(unknown.statusCode).toBe(404);
    const RANGE = { "rapport.style": [0, 4], "rapport.crash": [-2, 0], "rapport.extra": [0, 1] } as const;
    for (const [criterion, points] of [["rapport.style", 5], ["rapport.style", -1], ["rapport.crash", 1], ["rapport.crash", -3], ["rapport.extra", 2]] as const) {
      const res = await call("PUT", criterionUrl(w, repo, criterion), teacher.headers, { points });
      expect(res.statusCode, `${criterion} ${points}`).toBe(422);
      // The body names the range, which the field says.
      const [min, max] = RANGE[criterion];
      expect(PointsOutOfRange.parse(res.json())).toMatchObject({ error: "points_out_of_range", min, max });
    }

    const res = await call("PUT", criterionUrl(w, repo, "rapport.style"), teacher.headers, { points: 2.5 });
    expect(res.statusCode, res.body).toBe(200);
    const entry = ProjectGradingRepo.parse(res.json());
    // A teacher's edit is not a validation; none given, the rationale it replaces stays.
    expect(entry.table.find((r) => r.criterionId === "rapport.style")).toMatchObject({ points: 2.5, state: "proposed", source: "manual", rationale: XSS });
    expect((await call("PUT", criterionUrl(w, repo, "rapport.crash"), teacher.headers, { points: -2, rationale: "It crashes." })).statusCode).toBe(200);
    const rows = await standing(repo);
    expect(rows.find((r) => r.criterionId === "rapport.crash")).toMatchObject({ points: -2, source: "manual", state: "proposed", rationale: "It crashes.", createdBy: teacher.id });
    expect((await auditOf(repo, "project_repo.criterion_graded")).map((e) => e.payload)).toEqual([
      { projectId: w.projectId, criterionId: "rapport.style", points: 2.5, before: 3 },
      { projectId: w.projectId, criterionId: "rapport.crash", points: -2, before: 0 },
    ]);
  });

  it("waits for the definitive freeze, is refused off the mode, open to an assistant and nobody outside", async () => {
    const w = await world(1);
    const repo = await repoOf(w, w.students[0]!.id, { frozenAt: null });
    const early = await commits(w, repo);
    expect([early.statusCode, early.json().error]).toEqual([409, "not_frozen"]);
    await server.app.db.update(projectRepos).set({ frozenAt: at(FROZEN_AT) }).where(eq(projectRepos.id, repo));

    const stranger = await server.signIn("teacher");
    expect((await call("PUT", criterionUrl(w, repo, "git.commits"), stranger.headers, { points: 1 })).statusCode).toBe(404);
    expect((await call("POST", validateUrl(w, repo), stranger.headers)).statusCode).toBe(404);
    expect((await call("POST", `/app/api/projects/${w.projectId}/validate`, stranger.headers)).statusCode).toBe(404);
    expect((await call("PUT", criterionUrl(w, repo, "git.commits"), w.students[0]!.headers, { points: 1 })).statusCode).toBe(404);
    expect(await standing(repo)).toEqual([]);

    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: w.courseId, userId: assistant.id, role: "assistant" });
    expect((await call("PUT", criterionUrl(w, repo, "git.commits"), assistant.headers, { points: 1 })).statusCode).toBe(200);

    await server.app.db.update(projects).set({ gradingMode: "auto" }).where(eq(projects.id, w.projectId));
    const off = await commits(w, repo);
    expect([off.statusCode, off.json().error]).toEqual([409, "not_criteria"]);
  });
});

describe("Validate (ADR-106 §8)", () => {
  it("is refused while a teacher-only criterion has no row, then validates every proposal; the criteria score follows", async () => {
    const w = await world(1);
    const repo = await repoOf(w, w.students[0]!.id);
    await proposals(repo);
    await frozenRun(repo);

    const refused = await call("POST", validateUrl(w, repo));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "criteria_incomplete", repos: [{ repoId: repo, missing: ["git.commits"] }] });
    expect((await standing(repo)).every((r) => r.state === "proposed")).toBe(true);
    // Not validated: no criteria score — the final score falls through to the frozen run, never 0.
    expect(repoView(await detail(w), repo).scores.final).toMatchObject({ source: "ci", points: 6, max: 10 });
    expect((await detail(w)).primaryAction).toBe("grade");

    expect((await commits(w, repo, 0)).statusCode).toBe(200);
    const res = await call("POST", validateUrl(w, repo));
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectGradingRepo.parse(res.json())).toMatchObject({ validation: { validated: true, missing: [], proposed: [] }, total: { points: 12, max: 16 } });
    const rows = await standing(repo);
    expect(rows.map((r) => r.state)).toEqual(Array(5).fill("validated"));
    expect(rows.find((r) => r.criterionId === "rapport.style")).toMatchObject({ source: "llm", points: 3, rationale: XSS });
    expect((await auditOf(repo, "project_repo.validated")).map((e) => e.payload)).toEqual([{ projectId: w.projectId, criteria: 5, bulk: false }]);
    // 8 + 3 + 0 + 0 out of 16, the bonus on top: 12.
    const d = await detail(w);
    expect(repoView(d, repo).scores.final).toMatchObject({ source: "criteria", points: 12, max: 16 });
    expect(d.primaryAction).toBe("release");

    // Again: nothing more to validate, nothing audited.
    expect((await call("POST", validateUrl(w, repo))).statusCode).toBe(200);
    expect(await auditOf(repo, "project_repo.validated")).toHaveLength(1);
    // A teacher's later edit puts the repository back to validate: the score falls through again.
    expect((await commits(w, repo, 2)).statusCode).toBe(200);
    expect(repoView(await detail(w), repo).scores.final).toMatchObject({ source: "ci" });
  });
});

describe("the release gate and Validate the rest (ADR-106 §8, F-PROJ-26)", () => {
  it("refuses the release while a live repository is not validated; the bulk validation names what is missing, then lets it pass", async () => {
    const w = await world(2);
    const [a, b] = w.students;
    const first = await repoOf(w, a!.id);
    const second = await repoOf(w, b!.id);
    await proposals(first);
    await proposals(second);
    // A staff seat's test repository, never validated, holds nothing back (ADR-077).
    const staffer = await server.signIn("teacher");
    await server.app.db.insert(enrollments).values({ id: randomUUID(), classroomId: w.classroomId, nom: "T", prenom: "T", email: `t-${randomUUID()}@heig.test`, userId: staffer.id, staff: true });
    const test = await repoOf(w, staffer.id);

    const blocked = await call("POST", `/app/api/projects/${w.projectId}/release`);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().error).toBe("not_validated");
    expect([...blocked.json().repos].sort()).toEqual([first, second].sort());

    const bulkUrl = `/app/api/projects/${w.projectId}/validate`;
    const incomplete = await call("POST", bulkUrl);
    expect(incomplete.statusCode, incomplete.body).toBe(409);
    expect(incomplete.json().error).toBe("criteria_incomplete");
    expect(incomplete.json().repos).toEqual(expect.arrayContaining([{ repoId: first, missing: ["git.commits"] }, { repoId: second, missing: ["git.commits"] }]));
    expect(incomplete.json().repos).toHaveLength(2);
    expect(await auditOf(first, "project_repo.validated")).toEqual([]);
    // Refused as a whole: the first repository, complete itself, validated nothing either.
    await commits(w, first, 2);
    expect((await call("POST", bulkUrl)).statusCode).toBe(409);
    expect((await standing(first)).some((r) => r.state === "validated")).toBe(false);

    await commits(w, first, 2);
    await commits(w, second, 1);
    const bulk = await call("POST", bulkUrl);
    expect(bulk.statusCode, bulk.body).toBe(202);
    expect(ProjectValidated.parse(bulk.json())).toEqual({ validated: 2 });
    expect((await auditOf(second, "project_repo.validated")).map((e) => e.payload)).toEqual([{ projectId: w.projectId, criteria: 5, bulk: true }]);
    expect(await standing(test)).toEqual([]);

    const released = await call("POST", `/app/api/projects/${w.projectId}/release`);
    expect(released.statusCode, released.body).toBe(200);
    // The released snapshot stores the criteria total like any other source.
    const [row] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, first));
    expect([row!.releasedPoints, row!.releasedMax]).toEqual([14, 16]);
  });

  it("answers not_frozen when no repository is frozen for good, and leaves an auto project's release alone", async () => {
    const w = await world(1);
    await repoOf(w, w.students[0]!.id, { frozenAt: null });
    const none = await call("POST", `/app/api/projects/${w.projectId}/validate`);
    expect([none.statusCode, none.json().error]).toEqual([409, "not_frozen"]);

    const auto = await world(1);
    const repo = await repoOf(auto, auto.students[0]!.id);
    await frozenRun(repo);
    await server.app.db.update(projects).set({ gradingMode: "auto" }).where(eq(projects.id, auto.projectId));
    expect((await call("POST", `/app/api/projects/${auto.projectId}/release`)).statusCode).toBe(200);
  });
});
