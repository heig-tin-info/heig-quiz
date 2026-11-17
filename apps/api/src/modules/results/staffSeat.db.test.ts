/**
 * A teacher's staff seat reads its own copy as a student does, and stays out
 * of every class figure (ADR-018, amended 2026-11-17), over the real
 * application and the real migrations.
 *
 * The world: one exam of one question, sat by a student (0 / 1, a 1.0) and by
 * the teacher on the staff seat they took with Join (1 / 1, a 6.0), graded,
 * closed and released. A 6.0 anywhere in a class figure would be the seat's.
 *
 * What is lifted: the Grades page and the classroom's Grades tab show the
 * seat its own grade, computed live (the snapshot is the class's); it is told
 * of the release and of a correction of its copy. What is not: the release
 * snapshot, the results' statistics and per-question rates, the CSV, the
 * teacher's gradebook — its rows, its column and class means.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GradebookStaff, GradebookStudent, ReleasedGrades, StudentGrades } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { enrollments, notifications } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import { resultsCsv } from "./csv.js";
import * as results from "./service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let teacher: Session;
let student: Session;
let seed: Seeded;
let itemId: string;
let staffAttemptId: string;
let seatEmail: string;

const db = () => server.app.db;
const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const patch = (url: string, headers: Record<string, string>, payload: object) => server.app.inject({ method: "PATCH", url, headers, payload });
const gradebookUrl = () => `/app/api/classrooms/${seed.classroomId}/gradebook`;
const ownGradebookUrl = () => `/app/api/student/classrooms/${seed.classroomId}/gradebook`;

/** The notifications of `kind` a user holds on the exam. */
const told = (userId: string, kind: string) =>
  db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.evaluationId, seed.evaluationId), sql`${notifications.payload}->>'kind' = ${kind}`));

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-11-17T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [student.id], questions: 1 });
  const joined = await server.app.inject({ method: "POST", url: `/app/api/classrooms/${seed.classroomId}/self-enroll`, headers: teacher.headers });
  expect(joined.statusCode, joined.body).toBe(201);
  const [seat] = await db()
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.userId, teacher.id)));
  seatEmail = seat!.email;

  const now = server.clock.now();
  let evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", now);
  itemId = (await joinedItems(db(), seed.evaluationId))[0]!.item.id;
  for (const [userId, points] of [
    [student.id, 0],
    [teacher.id, 1],
  ] as const) {
    const participant = (await live.participantOf(db(), evaluation, userId))!;
    const attempt = await live.beginAttempt(db(), evaluation, await live.ensureAttempt(db(), evaluation, participant, now), participant, now);
    await live.submitAttempt(db(), evaluation, attempt, now);
    if (userId === teacher.id) staffAttemptId = attempt.id;
    await grading.writeGrading(db(), {
      attemptId: attempt.id,
      itemId,
      answerId: null,
      points,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      details: null,
      now,
    });
  }
  evaluation = await live.closeEvaluation(db(), evaluation, now, "teacher");
  await results.releaseResults(db(), await reload(db(), seed.evaluationId), now);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("a teacher's staff seat reads its own copy as a student (ADR-018, amended 2026-11-17)", () => {
  it("lists the released exam on its Grades page with the grade its answers earned", async () => {
    const res = await get("/app/api/student/results", teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const rows = StudentGrades.parse(res.json()).flatMap((g) => g.rows);
    expect(rows).toEqual([
      expect.objectContaining({ evaluationId: seed.evaluationId, status: "released", feedbackAttemptId: staffAttemptId, score: expect.objectContaining({ points: 1, grade: 6 }) }),
    ]);
  });

  it("draws the same cell on the classroom's Grades tab, and its own mean once the teacher publishes it", async () => {
    const own = GradebookStudent.parse((await get(ownGradebookUrl(), teacher.headers)).json());
    expect(own.cells[seed.evaluationId]).toEqual({ kind: "grade", grade: 6, points: 1, max: 1 });
    expect((await patch(gradebookUrl(), teacher.headers, { meanPublished: true })).statusCode).toBe(200);
    try {
      expect(GradebookStudent.parse((await get(ownGradebookUrl(), teacher.headers)).json()).mean).toBe(6);
      expect(GradebookStudent.parse((await get(ownGradebookUrl(), student.headers)).json()).mean).toBe(1);
    } finally {
      await patch(gradebookUrl(), teacher.headers, { meanPublished: false });
    }
  });

  it("is told of the release, beside the snapshot", async () => {
    expect((await told(teacher.id, "results_released")).map((n) => n.payload)).toEqual([
      expect.objectContaining({ kind: "results_released", attemptId: staffAttemptId }),
    ]);
    expect(await told(student.id, "results_released")).toHaveLength(1);
  });
});

describe("a teacher's staff seat stays out of every class figure (ADR-018)", () => {
  it("is not in the release snapshot", async () => {
    const snapshot = ReleasedGrades.parse((await reload(db(), seed.evaluationId)).releasedGrades);
    expect(snapshot.rows.map((r) => r.userId)).toEqual([student.id]);
  });

  it("is listed in the results, out of the statistics, the success rate and the CSV", async () => {
    const view = await results.resultsView(db(), await reload(db(), seed.evaluationId));
    expect(view.rows.find((r) => r.staff)).toMatchObject({ attemptId: staffAttemptId, grade: 6 });
    expect(view.stats).toMatchObject({ count: 1, mean: 1 });
    expect(view.items[0]!.successRate).toBe(0);
    const csv = resultsCsv(view);
    expect(csv).not.toContain(seatEmail);
  });

  it("is not a row of the teacher's gradebook, nor in a class mean", async () => {
    const res = await get(gradebookUrl(), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const table = GradebookStaff.parse(res.json());
    expect(table.rows.map((r) => r.email)).toEqual([expect.not.stringContaining(seatEmail)]);
    expect(table.columns.find((c) => c.activityId === seed.evaluationId)!.classMean).toBe(1);
    expect(table.classMean).toBe(1);
    expect(res.body).not.toContain(seatEmail);
    const csv = await get(`${gradebookUrl()}.csv`, teacher.headers);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.payload).not.toContain(seatEmail);
    expect(csv.payload).not.toMatch(/[;"]6(\.0)?[;\r"]/);
  });

  it("is told of a correction of its copy after the release; the class figures still hold the class", async () => {
    await grading.manualOverride(
      db(),
      { attemptId: staffAttemptId, itemId, answerId: null, maxPoints: 1, criteria: [] },
      { points: 0.5, comment: "re-read" },
      teacher.id,
      server.clock.now(),
    );
    expect((await told(teacher.id, "results_updated")).map((n) => n.payload)).toEqual([
      expect.objectContaining({ kind: "results_updated", attemptId: staffAttemptId, count: 1 }),
    ]);
    expect(await told(student.id, "results_updated")).toEqual([]);
    const rows = StudentGrades.parse((await get("/app/api/student/results", teacher.headers)).json()).flatMap((g) => g.rows);
    expect(rows[0]).toMatchObject({ score: { points: 0.5, grade: 3.5 } });
    const view = await results.resultsView(db(), await reload(db(), seed.evaluationId));
    expect(view.stats).toMatchObject({ count: 1, mean: 1 });
    expect(GradebookStaff.parse((await get(gradebookUrl(), teacher.headers)).json()).classMean).toBe(1);
  });
});
