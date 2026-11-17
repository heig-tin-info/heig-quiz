/**
 * A teacher's staff seat with a graded attempt stays out of every class
 * figure (ADR-018, amended 2026-11-17), over the real application and the
 * real migrations, now that it reads its own grades as a student does
 * (`studentGrades.db.test.ts`, `gradebook.db.test.ts`) and is told of its own
 * release and corrections (`updated.db.test.ts`).
 *
 * The world: one exam of one question, sat by a student (0 / 1, a 1.0) and by
 * the teacher on the staff seat they took with Join (1 / 1, a 6.0), graded,
 * closed and released. A 6.0 anywhere in a class figure would be the seat's:
 * the release snapshot, the results' statistics and per-question rates, the
 * CSV, the teacher's gradebook — its rows, its column and class means, its CSV.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GradebookStaff, ReleasedGrades } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { enrollments } from "../../db/schema.js";
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
let staffAttemptId: string;
let seatEmail: string;

const db = () => server.app.db;
const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const gradebookUrl = () => `/app/api/classrooms/${seed.classroomId}/gradebook`;

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
  const itemId = (await joinedItems(db(), seed.evaluationId))[0]!.item.id;
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
});
