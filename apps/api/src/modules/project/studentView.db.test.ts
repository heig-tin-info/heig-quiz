/**
 * The project's student view (F-PROJ-04, F-PROJ-07, F-PROJ-15, N-SEC-20;
 * merge task M3-09a) over the real application, on a server built with
 * Quiz's App against the fake GitHub and the local bare repositories (a
 * student's Accept really provisions), the clock moved by hand:
 *
 * - the cards on the home and the classroom page: a published project in
 *   the group its dates put it in, by the student's EFFECTIVE deadline; a
 *   draft never, an archived project never; the repository named once it
 *   exists, the account to link otherwise;
 * - the view in each state: to accept (linked or not), the invitation
 *   pending, in progress with an indicative score, grading `none`, locked
 *   and frozen (still indicative), released with the grade and the comment,
 *   the repository deleted;
 * - who reads it (invariant 6): a claimed seat, a teacher in the student
 *   view (no repository), an impersonation (read-only); a stranger, a
 *   token, a `seb` session, a draft, an archived project get the 404;
 * - the student's resend: pending only, the minute shared with the staff's
 *   route, nothing before Accept;
 * - THE LEAK TEST: a second student's repository, login, score, hint, the
 *   source and distribution repositories, a draft, the staff's flags, the
 *   review's and the teacher's score before the release — searched for in
 *   every response of the first student, for each student caller, and in
 *   every bus message their topics would carry;
 * - the criteria table (ADR-106 §9, L-02f): the student's own rows only,
 *   indicative until validated and released, a failed and a teacher-only
 *   row empty, the lock of a milestone; no rationale before the definitive
 *   freeze (a milestone's included), then the current rows' only — a
 *   superseded rationale, a row's source, reason, pass and checkpoint, the
 *   second student's rows and a project in another mode searched for in
 *   every response and message of the first.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CSRF_COOKIE,
  ProjectInvitationResent,
  ProjectSummary,
  StudentClassroomPage,
  StudentHome,
  StudentProject,
  type SessionKind,
  type StudentActivityCard,
} from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import {
  auditLog,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectCheckpoints,
  projectCriteria,
  projectEvidence,
  projectGradeRuns,
  projectRepos,
  projects,
  projectSyncPrs,
  pushReceipts,
} from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { studentHome as activityHome } from "../activity/service.js";
import { findStudentProjectView } from "../guards.js";
import { writeCriterionGrades } from "./criterionGrades.js";
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
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const MINUTE = 60_000;
const DAY = 24 * 3_600_000;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
interface Student {
  id: string;
  headers: Headers;
  githubUserId: number;
  login: string;
}

let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 72_000;
let nextAccount = 75_000;

/** GitHub's accounts by id, for the login lookups. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** A student, their GitHub account linked unless `linked: false`; `tag` makes the login distinctive. */
async function newStudent(opts: { linked?: boolean; tag?: string } = {}): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `${opts.tag ?? "kid"}${githubUserId}`;
  if (opts.linked !== false) {
    await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
    accounts.set(githubUserId, login);
  }
  return { ...signed, githubUserId, login };
}

const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

interface Room extends Seeded {
  org: string;
}

/** A classroom of `teacher`'s course, `students` enrolled, connected to a fresh organization holding the source `starter`. */
async function connectedClassroom(students: { id: string }[]): Promise<Room> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const org = `sorg-${n}`;
  world.orgIds[org] = n;
  world.source(org, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  return { ...seeded, org };
}

/** A project of `room`, published unless `publish: false`, through the staff's routes. */
async function project(room: Room, name: string, opts: { publish?: boolean; body?: object } = {}): Promise<ProjectSummary> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, teacher.headers, {
    name,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    ...opts.body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  if (opts.publish !== false) {
    expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  }
  return summary;
}

type RepoPatch = Partial<typeof projectRepos.$inferInsert>;
const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;
const setRepo = (id: string, patch: RepoPatch) => server.app.db.update(projectRepos).set(patch).where(eq(projectRepos.id, id));
const setProject = (id: string, patch: Partial<typeof projects.$inferInsert>) =>
  server.app.db.update(projects).set(patch).where(eq(projects.id, id));

/** `projectId` switched to grading by criteria, with `yml` as its snapshot (ADR-106 §1, §2). */
async function toCriteria(projectId: string, yml: string) {
  const parsed = parseCriteria(yml, { version: 2 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await setProject(projectId, { gradingMode: "criteria" });
  await server.app.db.insert(projectCriteria).values({ projectId, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: at(NOW) });
}

/** The criteria of the L-02f test: an automatic, a teacher's, three llm (one a milestone's) and a teacher-only criterion. */
const CRITERIA_YML = `schema_version: 2
criteria:
  rendu:
    tests: {description: Tests pass, awarded_points: 0, max_points: 4}
    build: {description: It builds, awarded_points: 0, max_points: 4}
  rapport:
    analyse: {description: Analysis, awarded_points: 0, max_points: 4}
    jalon: {description: Milestone, awarded_points: 0, max_points: 4}
    style: {description: Style, awarded_points: 0, max_points: 4}
  git:
    commits: {description: Commits, awarded_points: 0, max_points: 4}
`;
/** A rationale the page must show as text, never as markup (ADR-106 §6, N-SEC-14). */
const XSS_RATIONALE = "<script>alert(1)</script> Rationale-llm-current";

type RunPatch = Partial<typeof projectGradeRuns.$inferInsert>;
/** A stored run of the repository: a scored `ci` run 7/10 at NOW unless `patch` says otherwise. */
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
    completedAt: at(NOW),
    ...patch,
  });
  return id;
}

/** Every body a student caller received, for the leak test (N-SEC-20). */
const studentBodies: string[] = [];

const home = async (headers: Headers) => {
  const res = await call("GET", "/app/api/student/home", headers);
  studentBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(200);
  return StudentHome.parse(res.json());
};
const classroomPage = async (classroomId: string, headers: Headers) => {
  const res = await call("GET", `/app/api/student/classrooms/${classroomId}`, headers);
  studentBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(200);
  return StudentClassroomPage.parse(res.json());
};
const viewRaw = async (projectId: string, headers: Headers) => {
  const res = await call("GET", `/app/api/student/projects/${projectId}`, headers);
  studentBodies.push(res.body);
  return res;
};
const view = async (projectId: string, headers: Headers) => {
  const res = await viewRaw(projectId, headers);
  expect(res.statusCode, res.body).toBe(200);
  return StudentProject.parse(res.json());
};
const accept = async (projectId: string, who: { headers: Headers }) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  studentBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(200);
  return res;
};
const resend = async (projectId: string, headers: Headers) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/invite`, headers);
  studentBodies.push(res.body);
  return res;
};
const staffResend = (projectId: string, repoId: string) =>
  call("POST", `/app/api/projects/${projectId}/repos/${repoId}/invite`, teacher.headers);

/** A push receipt of the GitHub repository `githubRepoId`, as the intake writes it: a person's unless `isBot`. */
const receipt = (githubRepoId: number, receivedAt: Date, commits: number | null, isBot = false) =>
  server.app.db.insert(pushReceipts).values({
    id: randomUUID(),
    githubRepoId,
    branch: "main",
    headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    receivedAt,
    isBot,
    commits,
  });

const projectCards = (cards: StudentActivityCard[]) => cards.filter((c) => c.kind === "project");
const titles = (cards: StudentActivityCard[]) => projectCards(cards).map((c) => c.title);

/** A session of `kind` for `userId`, as the cookies a browser would send. */
async function sessionOf(userId: string, auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string }): Promise<Headers> {
  const s = await createSession(server.app.db, userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    projectId: null,
  });
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the cards

describe("the student's cards (F-PROJ-04, F-ORG-14, F-ORG-15)", () => {
  it("lists a published project under Open now, on the home and the classroom page; never a draft nor an archived one", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 1");
    await project(room, "Secret draft", { publish: false });
    const old = await project(room, "Old lab");
    expect((await call("POST", `/app/api/projects/${old.id}/archive`, teacher.headers)).statusCode).toBe(200);

    const h = await home(student.headers);
    expect(titles(h.open)).toEqual(["Lab 1"]);
    expect([...h.upcoming, ...h.past].filter((c) => c.kind === "project")).toEqual([]);
    expect(projectCards(h.open)[0]).toEqual({
      kind: "project",
      id: lab.id,
      title: "Lab 1",
      classroomId: room.classroomId,
      classroomName: "A",
      courseCode: expect.stringMatching(/^PRG-/),
      startAt: NOW,
      deadlineAt: DEADLINE,
      status: "to_accept",
      invitation: null,
      githubLinked: true,
      repoFullName: null,
      repoUrl: null,
      work: null,
    });
    const page = await classroomPage(room.classroomId, student.headers);
    expect(projectCards(page.activities.open)).toEqual(projectCards(h.open));
    expect(JSON.stringify([h, page])).not.toMatch(/Secret draft|Old lab/);
  });

  it("places a project by its dates: upcoming before the start, past once locked for the student, on their own deadline", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const soon = await project(room, "Soon");
    await setProject(soon.id, { startAt: at(NOW, 30 * DAY), deadlineAt: at(NOW, 45 * DAY) });
    const lab = await project(room, "Lab 2");
    await accept(lab.id, student);
    const extended = await project(room, "Extended");
    await accept(extended.id, student);

    let h = await home(student.headers);
    expect([titles(h.open), titles(h.upcoming), titles(h.past)]).toEqual([["Extended", "Lab 2"], ["Soon"], []]);
    expect(projectCards(h.upcoming)[0]!.status).toBe("to_accept");

    // The ticker applied the deadline (M3-05a); the student of `Extended` had their own, a week later.
    const ownDeadline = at(DEADLINE, 7 * DAY);
    await setRepo((await repoOf(extended.id, student.id)).id, { deadlineAt: ownDeadline });
    await setRepo((await repoOf(lab.id, student.id)).id, { deadlineAppliedAt: at(DEADLINE) });
    server.clock.set(at(DEADLINE, MINUTE));
    h = await home(student.headers);
    expect([titles(h.open), titles(h.past)]).toEqual([["Extended"], ["Lab 2"]]);
    expect(projectCards(h.past)[0]!.status).toBe("locked");
    expect(projectCards(h.open)[0]).toMatchObject({ status: "in_progress", deadlineAt: ownDeadline.toISOString() });
  });

  it("names the student's repository once accepted, and leads to linking the account otherwise", async () => {
    const linked = await newStudent();
    const unlinked = await newStudent({ linked: false });
    const room = await connectedClassroom([linked, unlinked]);
    const lab = await project(room, "Lab 3");
    await accept(lab.id, linked);

    const mine = projectCards((await home(linked.headers)).open)[0]!;
    expect(mine).toMatchObject({
      status: "in_progress",
      invitation: "pending",
      githubLinked: true,
      repoFullName: `${room.org}/lab-3-${linked.login}`,
      repoUrl: `https://github.com/${room.org}/lab-3-${linked.login}`,
    });
    const theirs = projectCards((await home(unlinked.headers)).open)[0]!;
    expect(theirs).toMatchObject({ status: "to_accept", invitation: null, githubLinked: false, repoFullName: null, repoUrl: null });
    // A staff seat holds no repository (ADR-018): the teacher's home lists nothing of it.
    expect(projectCards((await home(teacher.headers)).open)).toEqual([]);
  });

  it("says the state of the work (M3-14i): the last commit, the student's own commits by the deadline, the CI and the indicative score", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 5");
    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    const sha = "9".repeat(40);
    await setRepo(repo.id, {
      invitationStatus: "accepted",
      currentGradeRunId: await run(repo.id, { headSha: sha, points: 1, max: 6 }),
      lastCommitSha: sha,
      lastCommitAt: at(NOW),
      ciStatus: "fail",
    });
    const gid = repo.githubRepoId!;
    await receipt(gid, at(NOW, -DAY), 3);
    await receipt(gid, at(NOW, -MINUTE), null); // written before the count: one
    await receipt(gid, at(NOW), 40, true); // the App's or a workflow's: never the student's work
    await receipt(gid, at(DEADLINE, MINUTE), 7); // after the deadline: never shown

    const work = { lastCommit: { sha, at: NOW }, commits: 4, ciStatus: "fail", score: { points: 1, max: 6, frozen: false } };
    const card = projectCards((await home(student.headers)).open)[0]!;
    expect(card).toMatchObject({ status: "in_progress", work });
    expect(projectCards((await classroomPage(room.classroomId, student.headers)).activities.open)[0]).toEqual(card);
    // The page reads the same.
    expect((await view(lab.id, student.headers)).repo).toMatchObject(work);

    // Released: the card drops the indicative score, which the release's final one replaces.
    await setProject(lab.id, { releasedAt: at(NOW) });
    expect(projectCards((await home(student.headers)).past)[0]).toMatchObject({ status: "released", work: { commits: 4, score: null } });
  });
});

// ---------------------------------------------------------------- the view

describe("the student's project (F-PROJ-15)", () => {
  it("walks the states: to accept, invitation pending, in progress with an indicative score, locked and frozen, released", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 4");

    const before = await view(lab.id, student.headers);
    expect(before).toEqual({
      kind: "project",
      seat: "student",
      id: lab.id,
      title: "Lab 4",
      classroomId: room.classroomId,
      classroomName: "A",
      courseCode: expect.stringMatching(/^PRG-/),
      startAt: NOW,
      deadlineAt: DEADLINE,
      status: "to_accept",
      githubLinked: true,
      gradingMode: "auto",
      repo: null,
      release: null,
      // Not graded by criteria: no criteria table (ADR-106 §9).
      criteria: null,
      // No online workspace on this platform (ADR-047 §5): `CODESPACE_URL` is empty.
      workspace: null,
      serverNow: NOW,
    });

    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    const fullName = `${room.org}/lab-4-${student.login}`;
    const pending = await view(lab.id, student.headers);
    expect(pending.status).toBe("in_progress");
    expect(pending.repo).toEqual({
      fullName,
      url: `https://github.com/${fullName}`,
      invitation: "pending",
      deleted: false,
      locked: false,
      lastCommit: null,
      commits: 0,
      ciStatus: "none",
      run: null,
      score: null,
    });

    // The student pushed and their CI scored: the current run, indicative.
    const sha = "c".repeat(40);
    const current = await run(repo.id, { headSha: sha, workflowRunId: 4242, points: 7.5, max: 10 });
    await setRepo(repo.id, { invitationStatus: "accepted", currentGradeRunId: current, lastCommitSha: sha, lastCommitAt: at(NOW), ciStatus: "pass" });
    const scored = await view(lab.id, student.headers);
    expect(scored.repo).toMatchObject({
      invitation: "accepted",
      lastCommit: { sha, at: NOW },
      ciStatus: "pass",
      run: { sha, url: `https://github.com/${fullName}/actions/runs/4242`, conclusion: "success", completedAt: NOW },
      score: { points: 7.5, max: 10, grade: { grade: 4.8 }, frozen: false },
    });

    // The deadline passed, not yet applied by the ticker: the row's head moved to a late push, the view stands on the selected run.
    const lateSha = "f".repeat(40);
    await setRepo(repo.id, { lastCommitSha: lateSha, lastCommitAt: at(DEADLINE, 30_000), ciStatus: "fail" });
    server.clock.set(at(DEADLINE, MINUTE));
    const passed = await view(lab.id, student.headers);
    expect(passed.repo).toMatchObject({ lastCommit: { sha, at: null }, ciStatus: "pass", score: { points: 7.5, frozen: false } });
    expect(JSON.stringify(passed)).not.toContain(lateSha);

    // The deadline applied: the frozen run, never the one after the deadline; the review and the teacher's score not yet.
    const late = await run(repo.id, { headSha: lateSha, points: 99.5, max: 100, afterDeadline: true, completedAt: at(DEADLINE, MINUTE) });
    const review = await run(repo.id, { kind: "review", points: 33.5, max: 100, completedAt: at(DEADLINE, 2 * MINUTE) });
    await setRepo(repo.id, {
      deadlineAppliedAt: at(DEADLINE),
      frozenGradeRunId: current,
      currentGradeRunId: late,
      reviewGradeRunId: review,
      lockedAt: at(DEADLINE),
      teacherPoints: 8.25,
      teacherMax: 10,
      teacherComment: "Own-note",
      teacherGradedAt: at(DEADLINE, 3 * MINUTE),
    });
    server.clock.set(at(DEADLINE, 5 * MINUTE));
    const frozen = await view(lab.id, student.headers);
    expect(frozen.status).toBe("locked");
    expect(frozen.repo).toMatchObject({ locked: true, lastCommit: { sha, at: null }, ciStatus: "pass", score: { points: 7.5, max: 10, frozen: true } });
    expect(frozen.release).toBeNull();
    expect(JSON.stringify(frozen)).not.toMatch(new RegExp(`99\\.5|33\\.5|8\\.25|Own-note|review|teacher|${lateSha}`));

    // The release: the final score (the teacher's), its grade, the comment.
    await setRepo(repo.id, { frozenAt: at(DEADLINE, 30 * MINUTE) });
    server.clock.set(at(DEADLINE, DAY));
    const released = await call("POST", `/app/api/projects/${lab.id}/release`, teacher.headers);
    expect(released.statusCode, released.body).toBe(200);
    const after = await view(lab.id, student.headers);
    expect(after.status).toBe("released");
    expect(after.release).toEqual({
      at: at(DEADLINE, DAY).toISOString(),
      points: 8.25,
      max: 10,
      grade: { grade: 5.1 },
      comment: "Own-note",
    });
    // The indicative score stays what it was: the release is the one that counts.
    expect(after.repo!.score).toMatchObject({ points: 7.5, frozen: true });
    expect(projectCards((await home(student.headers)).past)[0]).toMatchObject({ status: "released" });

    // A comment rewritten after the release waits for the next one, like the score it may describe.
    await setRepo(repo.id, { teacherPoints: 9, teacherComment: "Rewritten-after" });
    const stale = await view(lab.id, student.headers);
    expect(stale.release).toMatchObject({ points: 8.25, comment: "Own-note" });
    expect(JSON.stringify(stale)).not.toContain("Rewritten-after");
  });

  it("shows no score under grading none, and says a deleted repository is gone", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 5", { body: { gradingMode: "none" } });
    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    const current = await run(repo.id, { points: 9, max: 10 });
    await setRepo(repo.id, { currentGradeRunId: current });
    const none = await view(lab.id, student.headers);
    expect(none.gradingMode).toBe("none");
    expect(none.repo!.run).not.toBeNull();
    expect(none.repo!.score).toBeNull();

    await setRepo(repo.id, { deletedAt: at(NOW, MINUTE) });
    const gone = await view(lab.id, student.headers);
    expect(gone.repo).toMatchObject({ fullName: repo.fullName, deleted: true, run: null, score: null });
    expect(gone.status).toBe("in_progress");
    expect(projectCards((await home(student.headers)).open)[0]).toMatchObject({ repoFullName: null, repoUrl: null, invitation: null });
  });
});

// ---------------------------------------------------------------- who reads it

describe("who reads the view (invariant 6, ADR-018, ADR-034)", () => {
  it("serves a teacher in the student view without a repository, and an impersonation through the seat, read-only", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 6");
    await accept(lab.id, student);

    const asTeacher = await view(lab.id, teacher.headers);
    expect(asTeacher).toMatchObject({ status: "to_accept", repo: null, githubLinked: false });

    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id });
    const asStudent = await view(lab.id, impersonation);
    expect(asStudent.repo).toMatchObject({ fullName: `${room.org}/lab-6-${student.login}` });
    const write = await resend(lab.id, impersonation);
    expect([write.statusCode, write.json().error]).toEqual([403, "impersonation_read_only"]);
  });

  it("answers a stranger, a seb session, a draft and an archived project as nobody; a token reads, never writes", async () => {
    const student = await newStudent();
    const stranger = await newStudent();
    const room = await connectedClassroom([student]);
    await connectedClassroom([stranger]);
    const lab = await project(room, "Lab 7");
    const draft = await project(room, "Draft 7", { publish: false });
    const old = await project(room, "Old 7");
    expect((await call("POST", `/app/api/projects/${old.id}/archive`, teacher.headers)).statusCode).toBe(200);
    const { token } = await createApiToken(server.app.db, student.id, { name: "t", expiresInDays: null, scope: "api" });
    const seb = await sessionOf(student.id, { kind: "seb", evaluationId: room.evaluationId });

    for (const [who, headers, id, expected] of [
      ["stranger", stranger.headers, lab.id, 404],
      ["seb", seb, lab.id, 401],
      ["draft", student.headers, draft.id, 404],
      ["archived", student.headers, old.id, 404],
      ["unknown", student.headers, randomUUID(), 404],
    ] as const) {
      const res = await viewRaw(id, headers);
      expect(res.statusCode, who).toBe(expected);
      const invite = await resend(id, headers);
      expect(invite.statusCode, `${who} invite`).toBe(expected);
    }
    // An API token reads what the student reads (the classroom's student branch), and writes nothing (the portal session only).
    const bearer = { authorization: `Bearer ${token}` };
    expect((await viewRaw(lab.id, bearer)).statusCode).toBe(200);
    expect((await resend(lab.id, bearer)).statusCode).toBe(404);

    // The loader's confined branch, directly: a `seb` or `kiosk` session reaches no project (the route's 401 comes first over HTTP).
    const caller = { id: student.id, role: "student" as const, reach: "seats" as const };
    for (const kind of ["seb", "kiosk"] as const) {
      expect(await findStudentProjectView(server.app.db, caller, { kind, actorUserId: null, projectId: null }, lab.id)).toBeNull();
    }
    expect(await findStudentProjectView(server.app.db, caller, { kind: "portal", actorUserId: null, projectId: null }, lab.id)).toMatchObject({
      project: { id: lab.id },
      seat: { staff: false },
    });

    // A confined session's home: the session guard refuses it over HTTP (401); should one ever reach the
    // service, it gets its evaluations and no project card leading to GitHub (`StudentScope.confined`).
    const kiosk = await sessionOf(student.id, { kind: "kiosk", evaluationId: room.evaluationId });
    for (const [kind, headers] of [["seb", seb], ["kiosk", kiosk]] as const) {
      expect((await call("GET", "/app/api/student/home", headers)).statusCode, kind).toBe(401);
    }
    const confinedHome = await activityHome(server.app.db, caller, { kind: "seb", actorUserId: null, projectId: null, evaluationId: room.evaluationId }, server.clock.now());
    studentBodies.push(JSON.stringify(confinedHome));
    expect([...confinedHome.open, ...confinedHome.upcoming, ...confinedHome.past].filter((c) => c.kind === "project")).toEqual([]);
    expect(JSON.stringify(confinedHome)).not.toContain(lab.id);
    const portalHome = await activityHome(server.app.db, caller, { kind: "portal", actorUserId: null, projectId: null, evaluationId: null }, server.clock.now());
    expect(portalHome.open.filter((c) => c.kind === "project").map((c) => c.id)).toEqual([lab.id]);
  });
});

// ---------------------------------------------------------------- the resend

describe("the student's resend (F-PROJ-07)", () => {
  it("re-invites a pending invitation, once a minute, the minute shared with the staff's route, audited as the student's", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab 8");
    const early = await resend(lab.id, student.headers);
    expect([early.statusCode, early.json().error]).toEqual([409, "repo_unavailable"]);

    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    world.collaborators.get(repo.fullName!)!.delete(student.login);
    const res = await resend(lab.id, student.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectInvitationResent.parse(res.json())).toEqual({ invitationStatus: "pending", resentAt: NOW });
    expect(world.collaborators.get(repo.fullName!)!.get(student.login)).toBe("push");
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, repo.id), eq(auditLog.action, "project_repo.invite_resent")));
    expect(entry).toMatchObject({ actorUserId: student.id, payload: { logins: [student.login], invitationStatus: "pending" } });

    // The same minute for whoever asks: the staff's resend is too soon, and so is the student's after the staff's.
    server.clock.advance(MINUTE - 1000);
    expect((await staffResend(lab.id, repo.id)).json().error).toBe("resend_too_soon");
    server.clock.advance(1000);
    world.collaborators.get(repo.fullName!)!.delete(student.login); // expired again, still pending
    expect((await staffResend(lab.id, repo.id)).statusCode).toBe(200);
    const soon = await resend(lab.id, student.headers);
    expect([soon.statusCode, soon.json().error]).toEqual([429, "resend_too_soon"]);

    // Accepted meanwhile: nothing to resend.
    await setRepo(repo.id, { invitationStatus: "accepted" });
    server.clock.advance(MINUTE);
    const done = await resend(lab.id, student.headers);
    expect([done.statusCode, done.json().error]).toEqual([409, "invitation_not_pending"]);
  });
});

// ---------------------------------------------------------------- the leak test

describe("the leak test (N-SEC-20, spec 05 §5.7)", () => {
  it("gives the first student nothing of the second, of the source and distribution, of a draft, of the staff's flags, nor of the unreleased scores", async () => {
    const messages: BusMessage[] = [];
    const unsubscribe = subscribe((m) => messages.push(m));
    try {
      const first = await newStudent({ tag: "alpha" });
      const second = await newStudent({ tag: "zulu" });
      const room = await connectedClassroom([first, second]);
      const lab = await project(room, "Lab 9");
      await project(room, "Secret draft", { publish: false });
      await accept(lab.id, first);
      await accept(lab.id, second);
      const mine = await repoOf(lab.id, first.id);
      const theirs = await repoOf(lab.id, second.id);
      // The source ahead and the sync's facts (M3-07): the staff's only.
      const sourceSha = "5ad0c0de".repeat(5);
      await setProject(lab.id, { sourceAheadSha: sourceSha, sourcePushedAt: at(NOW), sourceAhead: { main: 3 }, sourceHeads: { main: "c0ffee42".repeat(5) }, syncedAt: at(NOW) });
      await setRepo(mine.id, { syncOutcome: "opened", syncOutcomeAt: at(NOW) });
      await server.app.db.insert(projectSyncPrs).values({ repoId: mine.id, branch: "main", prNumber: 987654321, state: "open", updatedAt: at(NOW) });
      // The second student's run, review, teacher's score; a flagged run of the first's.
      await setRepo(theirs.id, {
        currentGradeRunId: await run(theirs.id, { points: 42.25, max: 100, headSha: "d".repeat(40) }),
        reviewGradeRunId: await run(theirs.id, { kind: "review", points: 33.5, max: 100 }),
        teacherPoints: 11.75,
        teacherMax: 100,
        teacherComment: "Hidden-note-two",
        lastCommitSha: "d".repeat(40),
      });
      // The second student's pushes, and the first's own after the deadline (M3-14i): never in a count of theirs.
      await receipt(theirs.githubRepoId!, at(NOW), 864200000);
      await receipt(mine.githubRepoId!, at(NOW), 2);
      await receipt(mine.githubRepoId!, at(DEADLINE, MINUTE), 531700000);
      // The first student's own: a flagged run, an unreleased review score, the teacher's score and comment.
      await setRepo(mine.id, {
        currentGradeRunId: await run(mine.id, { points: 7, max: 10, toVerify: true, headSha: "e".repeat(40) }),
        reviewGradeRunId: await run(mine.id, { kind: "review", points: 21.5, max: 100 }),
        teacherPoints: 8.5,
        teacherMax: 10,
        teacherComment: "Own-note-one",
        protectionSuspendedAt: at(NOW),
      });
      await run(mine.id, { parseStatus: "multiple", points: null, max: null });
      // A negative CI score counted 0 (M3-14n): the student sees 0, never the flag nor what the CI printed.
      const clamped = await run(mine.id, { points: 0, max: 10, parseDetail: "-3.75/10", clamped: true });
      const flagged = (await repoOf(lab.id, first.id)).currentGradeRunId;

      const admin = await server.signIn("admin");
      const impersonation = await sessionOf(first.id, { kind: "impersonation", actorUserId: admin.id });
      const { token } = await createApiToken(server.app.db, first.id, { name: "leak", expiresInDays: null, scope: "api" });
      const callers: Headers[] = [first.headers, teacher.headers, impersonation, { authorization: `Bearer ${token}` }];
      const read = async () => {
        for (const headers of callers) {
          await home(headers);
          await classroomPage(room.classroomId, headers);
          await view(lab.id, headers);
        }
        await accept(lab.id, first);
        await resend(lab.id, first.headers);
      };
      const from = studentBodies.length;
      // The clamped run is the one shown: the student reads a plain 0 (M3-14n).
      await setRepo(mine.id, { currentGradeRunId: clamped });
      expect((await view(lab.id, first.headers)).repo!.score).toMatchObject({ points: 0, max: 10 });
      await setRepo(mine.id, { currentGradeRunId: flagged });
      await read();
      // Locked, frozen, then released: the own comment and score come out, nothing else.
      // Past the deadline: the first student pushed again (the row's head moved) and a late run scored it.
      const frozenMine = (await repoOf(lab.id, first.id)).currentGradeRunId;
      const lateSha = "a1b2c3d4".repeat(5);
      const lateRun = await run(mine.id, { headSha: lateSha, points: 77.75, max: 100, afterDeadline: true, completedAt: at(DEADLINE, MINUTE) });
      await setRepo(mine.id, {
        deadlineAppliedAt: at(DEADLINE),
        frozenGradeRunId: frozenMine,
        currentGradeRunId: lateRun,
        frozenAt: at(DEADLINE, 30 * MINUTE),
        lastCommitSha: lateSha,
        lastCommitAt: at(DEADLINE, 30_000),
        ciStatus: "fail",
      });
      await setRepo(theirs.id, { deadlineAppliedAt: at(DEADLINE), frozenAt: at(DEADLINE, 30 * MINUTE) });
      server.clock.set(at(DEADLINE, DAY));
      await read();
      // Before the release, not even the student's own teacher score and comment.
      for (const body of studentBodies.slice(from)) {
        expect(body).not.toMatch(/8\.5|Own-note-one/);
      }
      // The teacher's score settles the flagged run (M3-08b): the release goes through.
      const released = await call("POST", `/app/api/projects/${lab.id}/release`, teacher.headers);
      expect(released.statusCode, released.body).toBe(200);
      // A comment rewritten after the release stays the staff's until the next one.
      await setRepo(mine.id, { teacherComment: "Rewritten-after-release" });
      await read();
      const after = await view(lab.id, first.headers);
      expect(after.release).toMatchObject({ points: 8.5, comment: "Own-note-one" });

      const forbidden = [
        theirs.fullName!,
        second.login,
        second.id,
        "d".repeat(40), // the second student's head
        "42.25",
        "33.5",
        "11.75",
        "Hidden-note-two",
        lateSha, // the first student's own push after the deadline
        "77.75", // and its run's score
        "864200000", // the second student's commits (nine digits: a random UUID or sha in a payload may hold any four)
        "864200002",
        "531700000", // the first student's own commits after the deadline
        "531700002",
        "21.5", // the first student's own review score, never released as such
        "Rewritten-after-release",
        "starter",
        "squashed",
        "Secret draft",
        "toVerify",
        "to_verify",
        "multiple",
        "malformed",
        "-3.75", // a negative CI score, as printed
        "clamped",
        "protectionSuspended",
        "sourceFullName",
        "distribution",
        sourceSha, // the source ahead (M3-07)
        "c0ffee42",
        "987654321", // the sync pull request's number
        "syncOutcome",
        "sourceAhead",
        "participantCount", // the staff list's count (ADR-018, amended 2026-10-13)
      ];
      expect(studentBodies.length).toBeGreaterThan(from + 30);
      for (const body of studentBodies.slice(from)) {
        for (const secret of forbidden) expect(body, secret).not.toContain(secret);
      }

      // The second student's hints go to their own topic and the course's staff, never where the first listens.
      const ctx = (await repoContext(server.app.db, theirs.githubRepoId!))!;
      await hintRepo(server.app.db, ctx);
      const theirHints = messages.filter((m) => m.kind === "hint" && m.topics.includes(`user:${second.id}`));
      expect(theirHints.length).toBeGreaterThan(0);
      const firstListens = new Set([`user:${first.id}`, `classroom:${room.classroomId}`]);
      for (const m of messages) {
        if (m.kind === "end") continue;
        if (m.topics.some((t) => firstListens.has(t))) {
          expect(JSON.stringify(m), "a message on the first student's topics").not.toMatch(new RegExp(`${second.id}|${theirs.id}|zulu`));
        }
      }
    } finally {
      unsubscribe();
    }
  });

  it("gives a student no total of a validated criteria repository before the release, then the criteria total, never a row's source (ADR-106 §7, §8)", async () => {
    const student = await newStudent({ tag: "crit" });
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Lab nine-b");
    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    await toCriteria(lab.id, `schema_version: 2
criteria:
  rendu:
    tests: {description: Tests, awarded_points: 0, max_points: 20}
`);
    // Frozen, an indicative CI score, and the criterion validated by the teacher: a criteria total of 13.25 / 20.
    await setRepo(repo.id, {
      currentGradeRunId: await run(repo.id, { points: 6, max: 10 }),
      deadlineAppliedAt: at(DEADLINE),
      frozenAt: at(DEADLINE, 30 * MINUTE),
    });
    await writeCriterionGrades(
      server.app.db,
      repo.id,
      [{ criterionId: "rendu.tests", points: 13.25, max: 20, source: "manual", state: "validated", rationale: "Own-rationale-x", passId: null }],
      at(DEADLINE, DAY),
    );
    server.clock.set(at(DEADLINE, DAY));
    const read = async () => {
      await home(student.headers);
      await classroomPage(room.classroomId, student.headers);
      return view(lab.id, student.headers);
    };
    const from = studentBodies.length;
    // Before the release: no total; after it, the criteria total, not the CI's 6 / 10.
    expect((await read()).release).toBeNull();
    const released = await call("POST", `/app/api/projects/${lab.id}/release`, teacher.headers);
    expect(released.statusCode, released.body).toBe(200);
    expect((await read()).release).toMatchObject({ points: 13.25, max: 20 });
    for (const body of studentBodies.slice(from)) {
      for (const secret of ['"source":', '"reason":']) expect(body, secret).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------- the criteria table (ADR-106 §9)

describe("the criteria table (ADR-106 §9, N-SEC-20, L-02f)", () => {
  it("shows the student their own rows only: indicative, no rationale before the freeze, provisional ones after it, the validated ones once released", async () => {
    const messages: BusMessage[] = [];
    const unsubscribe = subscribe((m) => messages.push(m));
    try {
      const first = await newStudent({ tag: "ada" });
      const second = await newStudent({ tag: "yuri" });
      const room = await connectedClassroom([first, second]);
      const lab = await project(room, "Lab ten");
      const other = await project(room, "Lab ten-auto");
      await accept(lab.id, first);
      await accept(lab.id, second);
      await accept(other.id, first);
      await toCriteria(lab.id, CRITERIA_YML);
      const mine = await repoOf(lab.id, first.id);
      const theirs = await repoOf(lab.id, second.id);
      const otherRepo = await repoOf(other.id, first.id);
      const checkpointId = randomUUID();
      await server.app.db.insert(projectCheckpoints).values({ id: checkpointId, projectId: lab.id, name: "mid", dueAt: at(NOW, -DAY) });
      const passId = randomUUID();
      const milestonePass = randomUUID();
      const write = (repoId: string, rows: Parameters<typeof writeCriterionGrades>[2], when = at(NOW, -DAY)) =>
        writeCriterionGrades(server.app.db, repoId, rows, when);
      // The first student's rows: an automatic proposal, an llm proposal over a superseded one, a milestone's locked
      // row, a failed pass, a validated row; no row for the teacher-only criterion.
      await write(mine.id, [{ criterionId: "rapport.analyse", points: 1.75, max: 4, source: "llm", state: "proposed", rationale: "Rationale-superseded-old", passId: randomUUID() }], at(NOW, -2 * DAY));
      await write(mine.id, [
        { criterionId: "rapport.jalon", points: 1.5, max: 4, source: "llm", state: "proposed", rationale: "Rationale-milestone-lock", passId: milestonePass, lockedByCheckpointId: checkpointId, lockedAt: at(NOW, -DAY) },
      ]);
      await write(mine.id, [
        { criterionId: "rendu.tests", points: 2.5, max: 4, source: "auto", state: "proposed", passId },
        { criterionId: "rapport.analyse", points: 3.25, max: 4, source: "llm", state: "proposed", rationale: XSS_RATIONALE, passId },
        { criterionId: "rapport.style", points: 0, max: 4, source: "llm", state: "proposed", reason: "llm_budget", passId },
        { criterionId: "rendu.build", points: 2.75, max: 4, source: "manual", state: "validated", rationale: "Rationale-validated-row", passId: null, createdBy: teacher.id },
      ]);
      // The second student's rows, and a row of the first on a project in another mode.
      await write(theirs.id, [
        { criterionId: "rendu.tests", points: 1.37, max: 4, source: "auto", state: "proposed", passId: randomUUID() },
        { criterionId: "rapport.analyse", points: 0.63, max: 4, source: "llm", state: "proposed", rationale: "Rationale-second-student", passId: randomUUID() },
      ]);
      await write(otherRepo.id, [{ criterionId: "rendu.tests", points: 3.91, max: 4, source: "auto", state: "proposed", rationale: "Rationale-other-mode", passId: randomUUID() }]);
      // The evidence's commits, the identity criterion's personal data (ADR-106 §2): their address never reaches a student.
      const commitEmail = "ada.commit-secret@heig-vd.ch";
      await server.app.db.insert(projectEvidence).values({
        id: passId,
        repoId: mine.id,
        targetSha: "c".repeat(40),
        distributionSha: "d".repeat(40),
        status: "ok",
        commits: [{ sha: "c".repeat(40), name: "Ada Commit-Secret", email: commitEmail, subject: "Rendu du labo" }],
        createdAt: at(NOW, -DAY),
      });

      const admin = await server.signIn("admin");
      const impersonation = await sessionOf(first.id, { kind: "impersonation", actorUserId: admin.id });
      const { token } = await createApiToken(server.app.db, first.id, { name: "criteria", expiresInDays: null, scope: "api" });
      const seb = await sessionOf(first.id, { kind: "seb", evaluationId: room.evaluationId });
      const callers: Headers[] = [first.headers, impersonation, { authorization: `Bearer ${token}` }];
      const read = async (): Promise<StudentProject> => {
        expect((await viewRaw(lab.id, seb)).statusCode).toBe(401);
        // A teacher in the student view holds no repository: no table.
        expect((await view(lab.id, teacher.headers)).criteria).toBeNull();
        expect((await view(other.id, first.headers)).criteria).toBeNull();
        let seen: StudentProject | null = null;
        for (const headers of callers) {
          await home(headers);
          await classroomPage(room.classroomId, headers);
          const got = await view(lab.id, headers);
          if (seen) expect(got.criteria).toEqual(seen.criteria);
          seen = got;
        }
        return seen!;
      };
      const rowsOf = (v: StudentProject) => Object.fromEntries(v.criteria!.map((r) => [r.criterionId, r]));
      const from = studentBodies.length;

      // Before the definitive freeze: points, indicative; the failed row and the teacher-only one empty; no rationale at all.
      const open = await read();
      expect(open.criteria!.map((r) => r.criterionId)).toEqual(["rendu.tests", "rendu.build", "rapport.analyse", "rapport.jalon", "rapport.style", "git.commits"]);
      expect(rowsOf(open)).toEqual({
        "rendu.tests": { criterionId: "rendu.tests", section: "rendu", description: "Tests pass", max: 4, points: 2.5, state: "indicative", locked: false },
        "rendu.build": { criterionId: "rendu.build", section: "rendu", description: "It builds", max: 4, points: 2.75, state: "indicative", locked: false },
        "rapport.analyse": { criterionId: "rapport.analyse", section: "rapport", description: "Analysis", max: 4, points: 3.25, state: "indicative", locked: false },
        "rapport.jalon": { criterionId: "rapport.jalon", section: "rapport", description: "Milestone", max: 4, points: 1.5, state: "indicative", locked: true },
        "rapport.style": { criterionId: "rapport.style", section: "rapport", description: "Style", max: 4, points: null, state: "empty", locked: false },
        "git.commits": { criterionId: "git.commits", section: "git", description: "Commits", max: 4, points: null, state: "empty", locked: false },
      });
      const beforeFreeze = studentBodies.slice(from);
      for (const body of beforeFreeze) {
        for (const secret of ["Rationale-", "alert(1)", "rationale"]) expect(body, secret).not.toContain(secret);
      }

      // After the definitive freeze: the provisional rationales of the current rows, never the superseded one.
      await setRepo(mine.id, { deadlineAppliedAt: at(DEADLINE), frozenAt: at(DEADLINE, 30 * MINUTE) });
      await setRepo(theirs.id, { deadlineAppliedAt: at(DEADLINE), frozenAt: at(DEADLINE, 30 * MINUTE) });
      server.clock.set(at(DEADLINE, DAY));
      const frozen = await read();
      expect(Object.values(rowsOf(frozen)).map((r) => [r.criterionId, r.state, r.rationale ?? null])).toEqual([
        ["rendu.tests", "indicative", null],
        ["rendu.build", "indicative", "Rationale-validated-row"],
        ["rapport.analyse", "indicative", XSS_RATIONALE],
        ["rapport.jalon", "indicative", "Rationale-milestone-lock"],
        ["rapport.style", "empty", null],
        ["git.commits", "empty", null],
      ]);

      // The teacher writes the missing criteria, validates the rest and releases.
      for (const [repoId, criterionId, points, rationale] of [
        [mine.id, "rapport.style", 1, "Rationale-teacher-style"],
        [mine.id, "git.commits", 4, null],
        [theirs.id, "rendu.build", 0, null],
        [theirs.id, "rapport.jalon", 0, null],
        [theirs.id, "rapport.style", 0, null],
        [theirs.id, "git.commits", 0, null],
      ] as const) {
        const graded = await call("PUT", `/app/api/projects/${lab.id}/repos/${repoId}/criteria/${criterionId}`, teacher.headers, { points, ...(rationale ? { rationale } : {}) });
        expect(graded.statusCode, graded.body).toBe(200);
      }
      const validated = await call("POST", `/app/api/projects/${lab.id}/validate`, teacher.headers);
      expect([validated.statusCode, validated.json()], validated.body).toEqual([202, { validated: 2 }]);
      // Validated, not released: still indicative.
      expect((await read()).criteria!.map((r) => r.state)).toEqual(Array(6).fill("indicative"));
      expect((await call("POST", `/app/api/projects/${lab.id}/release`, teacher.headers)).statusCode).toBe(200);
      const done = await read();
      expect(Object.values(rowsOf(done)).map((r) => [r.criterionId, r.points, r.state, r.rationale ?? null])).toEqual([
        ["rendu.tests", 2.5, "validated", null],
        ["rendu.build", 2.75, "validated", "Rationale-validated-row"],
        ["rapport.analyse", 3.25, "validated", XSS_RATIONALE],
        ["rapport.jalon", 1.5, "validated", "Rationale-milestone-lock"],
        ["rapport.style", 1, "validated", "Rationale-teacher-style"],
        ["git.commits", 4, "validated", null],
      ]);
      // The released total is the release's snapshot: 15 / 24 (ADR-106 §7), as before this table.
      expect(done.release).toMatchObject({ points: 15, max: 24 });
      expect(rowsOf(done)["rapport.jalon"]!.locked).toBe(true);

      // Searched in every response of the first student's callers, and every message on their topics (05 §5.7).
      const forbidden = [
        "Rationale-superseded-old",
        "Rationale-second-student",
        "Rationale-other-mode",
        "1.75", // the superseded row's points
        "1.37", // the second student's points
        "0.63",
        "3.91", // a row of a project in another mode
        "llm_budget",
        '"source":',
        '"reason":',
        '"passId"',
        "model",
        passId,
        milestonePass,
        checkpointId,
        theirs.id,
        second.login,
        second.id,
        commitEmail,
        "Commit-Secret",
        "c".repeat(40),
      ];
      const bodies = studentBodies.slice(from);
      expect(bodies.length).toBeGreaterThan(40);
      for (const body of bodies) {
        for (const secret of forbidden) expect(body, secret).not.toContain(secret);
      }
      const firstListens = new Set([`user:${first.id}`, `classroom:${room.classroomId}`]);
      for (const m of messages) {
        if (m.kind === "end" || !m.topics.some((t) => firstListens.has(t))) continue;
        const sent = JSON.stringify(m);
        for (const secret of ["Rationale-", "alert(1)", "llm_budget", '"source":', '"reason":', passId, milestonePass, checkpointId, theirs.id]) {
          expect(sent, secret).not.toContain(secret);
        }
      }
    } finally {
      unsubscribe();
    }
  });
});

describe("the hints of a project's creation (N-SEC-20, audit 2026-10-10 §6)", () => {
  it("reach the course's staff, never the classroom's topic", async () => {
    const room = await connectedClassroom([await newStudent()]);
    const topics: string[] = [];
    const unsubscribe = subscribe((m) => {
      if (m.kind === "hint") topics.push(...m.topics);
    });
    try {
      await project(room, "Lab hint", { publish: false });
      // The generic hint would be the `onResponse` hook's, after the answer is out.
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }
    expect(topics).toContain(`course:${room.courseId}`);
    expect(topics.filter((t) => t.startsWith("classroom:"))).toEqual([]);
  });
});
