/**
 * ADR-141: deleting what holds students' work is refused, for every role,
 * and the archive is offered instead. An exam or an exercise a student
 * started or that was released, a project with a graded repository or
 * released, and the classroom and the course that hold one, each answer
 * `409 holds_student_work` naming what blocks — never a name. A staff seat's
 * work (ADR-018), a poll's votes, a draft and a course template block
 * nothing. Each check runs again under the delete's locks: work landing
 * between the route's loader and the delete still refuses it.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EvaluationDetail, type EvaluationSummary, StudentWorkRefusal } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { SYSTEM_ACTOR } from "../../audit.js";
import {
  attempts,
  classrooms,
  courses,
  enrollments,
  evaluations,
  gradebookColumns,
  gradebookMarks,
  guestParticipants,
  projectCriterionGrades,
  projectGradeRuns,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Actor, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { gradedProject, projectRepo, type FixtureProject } from "../../test/project.js";
import * as evaluationService from "../evaluation/service.js";
import * as projectService from "../project/service.js";
import * as orgService from "./service.js";

let server: TestServer;
let restore: () => void;
let owner: Actor;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
});

afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const send = (method: "GET" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server.app.inject({ method, url, headers: owner.headers, ...(payload ? { payload } : {}) });

/** A course of the owner's, a classroom, two students, one exam. */
const seeded = (mode: "exam" | "exercise" = "exam") => seedLive(db(), { teacherId: owner.id, questions: 1, mode });

/** An attempt of `userId` (null: a poll guest), started or not. */
async function attemptBy(evaluationId: string, userId: string | null, started = true) {
  const guestId = userId === null ? randomUUID() : null;
  if (guestId) await db().insert(guestParticipants).values({ id: guestId, evaluationId, tokenHash: randomUUID() });
  await db()
    .insert(attempts)
    .values({ id: randomUUID(), evaluationId, userId, guestId, seed: 1, ...(started ? { startedAt: new Date() } : {}) });
}

/** The owner's staff seat in the classroom (ADR-018): a teacher in the student view. */
async function staffSeat(classroomId: string) {
  await db().insert(enrollments).values({
    id: randomUUID(),
    classroomId,
    nom: "Staff",
    prenom: "Seat",
    email: `seat-${randomUUID().slice(0, 8)}@heig.test`,
    userId: owner.id,
    claimedAt: new Date(),
    staff: true,
  });
}

/**
 * A gradebook mark of `kind` on the first student of the seed, in the column
 * of the evaluation or the project `activity`, as `setMark` stores it.
 */
async function markOn(seed: Seeded, activity: { evaluationId: string } | { projectId: string }, kind: "score" | "excused") {
  const [seat] = await db()
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(eq(enrollments.userId, seed.studentIds[0]!));
  const columnId = randomUUID();
  await db().insert(gradebookColumns).values({ id: columnId, classroomId: seed.classroomId, ...activity, counts: true, updatedAt: new Date() });
  await db()
    .insert(gradebookMarks)
    .values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      columnId,
      enrollmentId: seat!.id,
      kind,
      ...(kind === "score" ? { points: 4, max: 6 } : {}),
      setAt: new Date(),
    });
}

const deleteEvaluation = (seed: Seeded) =>
  send("DELETE", `/app/api/evaluations/${seed.evaluationId}`, { confirmTitle: "Test évaluation" });
const deleteClassroom = (seed: Seeded) => send("DELETE", `/app/api/classrooms/${seed.classroomId}`);
const deleteCourse = (seed: Seeded) => send("DELETE", `/app/api/courses/${seed.courseId}`);

/** The refusal's body, checked against its contract. */
function refusal(res: { statusCode: number; json: () => unknown }) {
  expect(res.statusCode).toBe(409);
  return StudentWorkRefusal.parse(res.json()).work;
}

const exists = async (table: typeof evaluations | typeof classrooms | typeof courses | typeof projects, id: string) =>
  (await db().select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;

describe("an exam or an exercise", () => {
  it("is refused once a student started it, whatever the role, before the title is checked", async () => {
    const seed = await seeded();
    await attemptBy(seed.evaluationId, seed.studentIds[0]!);
    await attemptBy(seed.evaluationId, seed.studentIds[1]!);
    for (const res of [await deleteEvaluation(seed), await send("DELETE", `/app/api/evaluations/${seed.evaluationId}`, { confirmTitle: "wrong" })]) {
      expect(refusal(res)).toEqual({ classrooms: 1, evaluations: 1, projects: 0, attempts: 2, gradedRepos: 0, marks: 0, released: 0 });
    }
    expect(await exists(evaluations, seed.evaluationId)).toBe(true);
    // The payloads say so, for the screens to grey Delete out.
    const detail = (await send("GET", `/app/api/evaluations/${seed.evaluationId}`)).json() as EvaluationDetail;
    const list = (await send("GET", `/app/api/classrooms/${seed.classroomId}/evaluations`)).json() as EvaluationSummary[];
    expect([detail.holdsStudentWork, list.find((e) => e.id === seed.evaluationId)?.holdsStudentWork]).toEqual([true, true]);
  });

  it("is refused once released, with no attempt", async () => {
    const seed = await seeded("exercise");
    await db().update(evaluations).set({ releasedAt: new Date() }).where(eq(evaluations.id, seed.evaluationId));
    expect(refusal(await deleteEvaluation(seed))).toMatchObject({ evaluations: 1, attempts: 0, released: 1 });
  });

  it("goes with an attempt nobody started, a staff seat's attempt, or a poll's guests", async () => {
    const unstarted = await seeded();
    await attemptBy(unstarted.evaluationId, unstarted.studentIds[0]!, false);
    expect((await deleteEvaluation(unstarted)).statusCode).toBe(204);

    const rehearsed = await seeded();
    await staffSeat(rehearsed.classroomId);
    await attemptBy(rehearsed.evaluationId, owner.id);
    const detail = (await send("GET", `/app/api/evaluations/${rehearsed.evaluationId}`)).json() as EvaluationDetail;
    expect(detail.holdsStudentWork).toBe(false);
    expect((await deleteEvaluation(rehearsed)).statusCode).toBe(204);

    const poll = await seeded();
    await db().update(evaluations).set({ mode: "poll", releasedAt: new Date() }).where(eq(evaluations.id, poll.evaluationId));
    await attemptBy(poll.evaluationId, null);
    await attemptBy(poll.evaluationId, poll.studentIds[0]!);
    expect((await deleteEvaluation(poll)).statusCode).toBe(204);
  });

  it("decides again under the row's lock: a student starting after the loader still refuses it", async () => {
    const seed = await seeded();
    const loaded = await reload(db(), seed.evaluationId);
    expect(await evaluationService.studentWorkRefusal(db(), seed.evaluationId)).toBeNull();
    await attemptBy(seed.evaluationId, seed.studentIds[0]!);
    await expect(evaluationService.deleteEvaluation(db(), loaded, "owner")).rejects.toMatchObject({
      code: "holds_student_work",
      status: 409,
    });
    expect(await exists(evaluations, seed.evaluationId)).toBe(true);
  });
});

describe("an exam sat on paper, and the gradebook's scores", () => {
  it("refuses an exam whose only work is a paper copy, entered submitted and never started", async () => {
    const seed = await seeded();
    // As `insertPaperAttempt` writes it.
    await db().insert(attempts).values({
      id: randomUUID(),
      evaluationId: seed.evaluationId,
      userId: seed.studentIds[0]!,
      seed: 1,
      origin: "paper",
      state: "submitted",
      submittedAt: new Date(),
    });
    expect(refusal(await deleteEvaluation(seed))).toMatchObject({ evaluations: 1, attempts: 1, marks: 0, released: 0 });
    const detail = (await send("GET", `/app/api/evaluations/${seed.evaluationId}`)).json() as EvaluationDetail;
    expect(detail.holdsStudentWork).toBe(true);
  });

  it("refuses an exam with no attempt but a teacher's score in the gradebook; an excuse alone does not block", async () => {
    const scored = await seeded();
    await markOn(scored, { evaluationId: scored.evaluationId }, "score");
    expect(refusal(await deleteEvaluation(scored))).toMatchObject({ evaluations: 1, attempts: 0, marks: 1 });
    const list = (await send("GET", `/app/api/classrooms/${scored.classroomId}/evaluations`)).json() as EvaluationSummary[];
    expect(list.find((e) => e.id === scored.evaluationId)?.holdsStudentWork).toBe(true);
    expect(refusal(await deleteClassroom(scored))).toMatchObject({ marks: 1 });

    const excused = await seeded();
    await markOn(excused, { evaluationId: excused.evaluationId }, "excused");
    expect((await deleteEvaluation(excused)).statusCode).toBe(204);
  });

  it("refuses a project with a gradebook score and nothing else", async () => {
    const seed = await seeded();
    const project = await gradedProject(db(), { classroomId: seed.classroomId, name: "Lab", createdBy: owner.id, released: false });
    await markOn(seed, { projectId: project.id }, "score");
    const row = (await db().select().from(projects).where(eq(projects.id, project.id)))[0]!;
    await expect(projectService.deleteProject(db(), row, SYSTEM_ACTOR)).rejects.toMatchObject({
      code: "holds_student_work",
      details: { work: { projects: 1, gradedRepos: 0, marks: 1 } },
    });
  });

  it("decides again under the lock: a score set after the loader still refuses the evaluation", async () => {
    const seed = await seeded();
    const loaded = await reload(db(), seed.evaluationId);
    expect(await evaluationService.studentWorkRefusal(db(), seed.evaluationId)).toBeNull();
    await markOn(seed, { evaluationId: seed.evaluationId }, "score");
    await expect(evaluationService.deleteEvaluation(db(), loaded, "owner")).rejects.toMatchObject({ code: "holds_student_work" });
  });
});

describe("a project", () => {
  const projectIn = (seed: Seeded, released = false) =>
    gradedProject(db(), { classroomId: seed.classroomId, name: "Lab", createdBy: owner.id, released });
  const rowOf = async (id: string) => (await db().select().from(projects).where(eq(projects.id, id)))[0]!;
  const remove = async (project: FixtureProject) => projectService.deleteProject(db(), await rowOf(project.id), SYSTEM_ACTOR);
  /** A student's repository with no grade at all. */
  async function bareRepo(project: FixtureProject, userId: string) {
    const id = randomUUID();
    await db().insert(projectRepos).values({ id, projectId: project.id, userId, acceptedAt: new Date() });
    return id;
  }

  it("is refused once a student repository is graded, by a score, a validated criterion or a run", async () => {
    const seed = await seeded();
    const scored = await projectIn(seed);
    await projectRepo(db(), scored, { userId: seed.studentIds[0]!, points: 8, max: 10 });
    await expect(remove(scored)).rejects.toMatchObject({ code: "holds_student_work", status: 409, details: { work: { projects: 1, gradedRepos: 1 } } });

    const validated = await projectIn(seed);
    const repo = await bareRepo(validated, seed.studentIds[0]!);
    const criterion = { id: randomUUID(), repoId: repo, criterionId: "c1", points: 1, max: 2, source: "manual" as const, createdAt: new Date() };
    await db().insert(projectCriterionGrades).values({ ...criterion, state: "proposed" });
    await remove(validated).catch(() => expect.fail("a proposal is no grade"));
    const again = await projectIn(seed);
    const repo2 = await bareRepo(again, seed.studentIds[0]!);
    await db().insert(projectCriterionGrades).values({ ...criterion, id: randomUUID(), repoId: repo2, state: "validated" });
    await expect(remove(again)).rejects.toMatchObject({ code: "holds_student_work" });

    const ran = await projectIn(seed);
    const repo3 = await bareRepo(ran, seed.studentIds[1]!);
    await db().insert(projectGradeRuns).values({
      id: randomUUID(),
      repoId: repo3,
      workflowRunId: 1,
      headBranch: "main",
      headSha: "a".repeat(40),
      conclusion: "success",
      parseStatus: "ok",
      completedAt: new Date(),
    });
    await expect(remove(ran)).rejects.toMatchObject({ code: "holds_student_work" });
    for (const p of [scored, again, ran]) expect(await exists(projects, p.id)).toBe(true);
  });

  it("is refused once released, its refusal the contract's body", async () => {
    const seed = await seeded();
    const released = await projectIn(seed, true);
    const error = (await remove(released).catch((e: unknown) => e)) as { code: string; status: number; message: string; details: object };
    expect(error.status).toBe(409);
    const body = StudentWorkRefusal.parse({ error: error.code, message: error.message, ...error.details });
    expect(body.work).toMatchObject({ projects: 1, gradedRepos: 0, released: 1 });
  });

  it("goes as a draft, with ungraded repositories, or graded on a staff seat's repository only", async () => {
    const seed = await seeded();
    const draft = await projectIn(seed);
    await db().update(projects).set({ state: "draft" }).where(eq(projects.id, draft.id));
    await remove(draft);
    expect(await exists(projects, draft.id)).toBe(false);

    const ungraded = await projectIn(seed);
    await bareRepo(ungraded, seed.studentIds[0]!);
    await remove(ungraded);
    expect(await exists(projects, ungraded.id)).toBe(false);

    await staffSeat(seed.classroomId);
    const rehearsed = await projectIn(seed);
    await projectRepo(db(), rehearsed, { userId: owner.id, points: 10, max: 10 });
    await remove(rehearsed);
    expect(await exists(projects, rehearsed.id)).toBe(false);
  });

  it("decides again under the project's lock: a grade landing after the loader still refuses it", async () => {
    const seed = await seeded();
    const project = await projectIn(seed);
    const loaded = await rowOf(project.id);
    await projectRepo(db(), project, { userId: seed.studentIds[0]!, points: 3, max: 10 });
    await expect(projectService.deleteProject(db(), loaded, SYSTEM_ACTOR)).rejects.toMatchObject({ code: "holds_student_work" });
  });
});

describe("a classroom and a course", () => {
  it("refuse while one of their activities holds students' work, counting each kind", async () => {
    const seed = await seeded();
    await attemptBy(seed.evaluationId, seed.studentIds[0]!);
    const project = await gradedProject(db(), { classroomId: seed.classroomId, name: "Lab", createdBy: owner.id, released: true });
    await projectRepo(db(), project, { userId: seed.studentIds[0]!, points: 8, max: 10 });
    const expected = { classrooms: 1, evaluations: 1, projects: 1, attempts: 1, gradedRepos: 1, marks: 0, released: 1 };
    expect(refusal(await deleteClassroom(seed))).toEqual(expected);
    expect(refusal(await deleteCourse(seed))).toEqual(expected);
    expect(await exists(classrooms, seed.classroomId)).toBe(true);
    expect(await exists(courses, seed.courseId)).toBe(true);
    // The archive stays the way out.
    expect((await server.app.inject({ method: "POST", url: `/app/api/classrooms/${seed.classroomId}/archive`, headers: owner.headers })).statusCode).toBe(204);
  });

  it("a course is refused for any of its classrooms, and counts them", async () => {
    const seed = await seeded();
    const other = await seedLive(db(), { teacherId: owner.id, questions: 1 });
    await db().update(classrooms).set({ courseId: seed.courseId }).where(eq(classrooms.id, other.classroomId));
    await attemptBy(seed.evaluationId, seed.studentIds[0]!);
    await db().update(evaluations).set({ releasedAt: new Date() }).where(eq(evaluations.id, other.evaluationId));
    expect(refusal(await deleteCourse(seed))).toMatchObject({ classrooms: 2, evaluations: 2, attempts: 1, released: 1 });
  });

  it("go with a staff seat's work, a poll's votes, drafts and the course's templates", async () => {
    const seed = await seeded();
    await staffSeat(seed.classroomId);
    await attemptBy(seed.evaluationId, owner.id);
    const poll = await seedLive(db(), { teacherId: owner.id, questions: 1 });
    await db().update(classrooms).set({ courseId: seed.courseId }).where(eq(classrooms.id, poll.classroomId));
    await db().update(evaluations).set({ mode: "poll", releasedAt: new Date() }).where(eq(evaluations.id, poll.evaluationId));
    await attemptBy(poll.evaluationId, poll.studentIds[0]!);
    const draft = await gradedProject(db(), { classroomId: seed.classroomId, name: "Draft", createdBy: owner.id, released: false });
    await db().update(projects).set({ state: "draft" }).where(eq(projects.id, draft.id));
    const template = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/template`,
      headers: owner.headers,
      payload: { title: "Modèle" },
    });
    expect(template.statusCode).toBe(201);

    expect((await deleteClassroom(poll)).statusCode).toBe(204);
    expect((await deleteCourse(seed)).statusCode).toBe(204);
    expect(await exists(courses, seed.courseId)).toBe(false);
  });

  it("decide again under the classroom's lock: an attempt started after the route's check still refuses it", async () => {
    const seed = await seeded();
    await orgService.refuseStudentWork(db(), { classroomId: seed.classroomId });
    await attemptBy(seed.evaluationId, seed.studentIds[0]!);
    await expect(orgService.deleteClassroom(db(), seed.classroomId)).rejects.toMatchObject({ code: "holds_student_work", status: 409 });
    await expect(orgService.deleteCourse(db(), seed.courseId)).rejects.toMatchObject({ code: "holds_student_work" });
    expect(await exists(classrooms, seed.classroomId)).toBe(true);
  });
});
