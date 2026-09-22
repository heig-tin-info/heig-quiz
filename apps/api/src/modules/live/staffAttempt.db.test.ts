/**
 * ADR-018 — the real student view, over the REAL application: a teacher
 * takes their own quiz from a staff seat, resets that attempt, and the row it
 * leaves behind is shown everywhere and counted nowhere.
 *
 * It goes through `test/http.ts` rather than the services alone, because two
 * of the three things being asserted ARE the HTTP surface: who may call
 * `DELETE /evaluations/:id/attempt` (the guard) and what a student gets when
 * they try (a 403, not a silent no-op).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import {
  answers,
  attemptEvents,
  attempts,
  auditLog,
  enrollments,
  gradings,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as gradingService from "../grading/service.js";
import { resultsCsv } from "../results/csv.js";
import * as resultsService from "../results/service.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-20T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
const del = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "DELETE", url, headers });

/**
 * A running evaluation of one question, with one student enrolled. Each call
 * builds its own course and classroom, so the tests below never share a row.
 */
async function running(questions = 1) {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions,
  });
  await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  const items = await joinedItems(db, seed.evaluationId);
  return { seed, itemId: items[0]!.item.id };
}

/** The teacher takes a staff seat and walks the evaluation to the end. */
async function walkAsStaff(world: Awaited<ReturnType<typeof running>>) {
  const enrolled = await post(
    `/app/api/classrooms/${world.seed.classroomId}/self-enroll`,
    teacher.headers,
  );
  expect(enrolled.statusCode).toBe(201);
  const entered = await post(
    `/app/api/evaluations/${world.seed.evaluationId}/attempt`,
    teacher.headers,
    {},
  );
  expect(entered.statusCode).toBe(200);
  return entered.json() as { kind: string; view: { attempt: { id: string } } };
}

describe("a staff seat walks the real student flow (ADR-018)", () => {
  it("enters, answers and submits, exactly as a student does", async () => {
    const world = await running();
    const entered = await walkAsStaff(world);
    expect(entered.kind).toBe("attempt");
    const attemptId = entered.view.attempt.id;

    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${world.itemId}`,
      headers: teacher.headers,
      payload: { payload: "answer-q0", revision: 1, clientTs: "2026-09-20T09:00:00.000Z" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().accepted).toBe(true);

    const submitted = await post(
      `/app/api/attempts/${attemptId}/submit`,
      teacher.headers,
      { confirm: true },
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().state).toBe("submitted");
  });

  it("tells the evaluation page what seat the reader holds", async () => {
    const world = await running();
    const before = await get(`/app/api/evaluations/${world.seed.evaluationId}`, teacher.headers);
    expect(before.json().self).toEqual({ seat: false, staffSeat: false, attemptId: null });

    const entered = await walkAsStaff(world);
    const after = await get(`/app/api/evaluations/${world.seed.evaluationId}`, teacher.headers);
    expect(after.json().self).toEqual({
      seat: true,
      staffSeat: true,
      attemptId: entered.view.attempt.id,
    });
  });
});

describe("resetting one's own test attempt (ADR-018)", () => {
  it("removes the attempt and every row that hangs off it", async () => {
    const db = server.app.db;
    const world = await running();
    const entered = await walkAsStaff(world);
    const attemptId = entered.view.attempt.id;

    await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${world.itemId}`,
      headers: teacher.headers,
      payload: { payload: "answer-q0", revision: 1, clientTs: "2026-09-20T09:00:00.000Z" },
    });
    await post(`/app/api/attempts/${attemptId}/events`, teacher.headers, { kind: "focus" });
    await gradingService.writeGrading(db, {
      attemptId,
      itemId: world.itemId,
      answerId: null,
      points: 1,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      details: null,
      now: server.clock.now(),
    });

    const reset = await del(`/app/api/evaluations/${world.seed.evaluationId}/attempt`, teacher.headers);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ deleted: true });

    expect(await db.select().from(attempts).where(eq(attempts.id, attemptId))).toHaveLength(0);
    expect(await db.select().from(answers).where(eq(answers.attemptId, attemptId))).toHaveLength(0);
    expect(
      await db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId)),
    ).toHaveLength(0);
    expect(await db.select().from(gradings).where(eq(gradings.attemptId, attemptId))).toHaveLength(0);

    const trace = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "attempt.staff_reset"));
    expect(trace.length).toBeGreaterThan(0);

    // And the walk can start again: the route is idempotent per participant,
    // so this is the whole point of the reset.
    const again = await post(
      `/app/api/evaluations/${world.seed.evaluationId}/attempt`,
      teacher.headers,
      {},
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().view.attempt.id).not.toBe(attemptId);
  });

  it("answers `deleted: false` when the teacher has no attempt of their own", async () => {
    const world = await running();
    const reset = await del(`/app/api/evaluations/${world.seed.evaluationId}/attempt`, teacher.headers);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ deleted: false });
  });

  it("refuses a student outright", async () => {
    const world = await running();
    const reset = await del(`/app/api/evaluations/${world.seed.evaluationId}/attempt`, student.headers);
    expect(reset.statusCode).toBe(403);
  });

  it("is a 404 for a teacher who is not on the course's staff", async () => {
    const world = await running();
    const stranger = await server.signIn("teacher");
    const reset = await del(
      `/app/api/evaluations/${world.seed.evaluationId}/attempt`,
      stranger.headers,
    );
    expect(reset.statusCode).toBe(404);
  });

  it("never touches a student's attempt", async () => {
    const db = server.app.db;
    const world = await running();
    await walkAsStaff(world);
    const studentEntry = await post(
      `/app/api/evaluations/${world.seed.evaluationId}/attempt`,
      student.headers,
      {},
    );
    const studentAttemptId = studentEntry.json().view.attempt.id;

    expect(
      (await del(`/app/api/evaluations/${world.seed.evaluationId}/attempt`, teacher.headers)).json(),
    ).toEqual({ deleted: true });
    expect(
      await db.select().from(attempts).where(eq(attempts.id, studentAttemptId)),
    ).toHaveLength(1);
  });

  it("refuses when the caller's own seat is not a staff seat", async () => {
    const db = server.app.db;
    const world = await running();
    const entered = await walkAsStaff(world);
    // The same person, the same attempt — but a seat that is no longer a
    // staff one. The route then has nothing it may delete.
    await db
      .update(enrollments)
      .set({ staff: false })
      .where(
        and(
          eq(enrollments.classroomId, world.seed.classroomId),
          eq(enrollments.userId, teacher.id),
        ),
      );

    const reset = await del(`/app/api/evaluations/${world.seed.evaluationId}/attempt`, teacher.headers);
    expect(reset.json()).toEqual({ deleted: false });
    expect(
      await db.select().from(attempts).where(eq(attempts.id, entered.view.attempt.id)),
    ).toHaveLength(1);
  });
});

describe("the staff attempt is shown, badged, and counted nowhere (ADR-018)", () => {
  /** One class answer and one staff answer on the same question, both graded. */
  async function graded() {
    const db = server.app.db;
    const world = await running();
    const staffEntry = await walkAsStaff(world);
    const studentEntry = await post(
      `/app/api/evaluations/${world.seed.evaluationId}/attempt`,
      student.headers,
      {},
    );
    const staffAttemptId = staffEntry.view.attempt.id;
    const studentAttemptId = studentEntry.json().view.attempt.id;

    for (const [attemptId, headers] of [
      [staffAttemptId, teacher.headers],
      [studentAttemptId, student.headers],
    ] as const) {
      await server.app.inject({
        method: "PUT",
        url: `/app/api/attempts/${attemptId}/answers/${world.itemId}`,
        headers,
        payload: { payload: "answer-q0", revision: 1, clientTs: "2026-09-20T09:00:00.000Z" },
      });
      await post(`/app/api/attempts/${attemptId}/answers/${world.itemId}/done`, headers, {
        done: true,
      });
    }

    // The teacher knows the key and scores full marks; the student does not.
    await gradingService.writeGrading(db, {
      attemptId: staffAttemptId,
      itemId: world.itemId,
      answerId: null,
      points: 1,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      details: null,
      now: server.clock.now(),
    });
    await gradingService.writeGrading(db, {
      attemptId: studentAttemptId,
      itemId: world.itemId,
      answerId: null,
      points: 0,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      details: null,
      now: server.clock.now(),
    });
    return { world, staffAttemptId, studentAttemptId };
  }

  it("marks the row on the live dashboard and keeps it out of the totals", async () => {
    const built = await graded();
    const view = (
      await get(
        `/app/api/evaluations/${built.world.seed.evaluationId}/dashboard`,
        teacher.headers,
      )
    ).json();

    const staffRow = view.rows.find((r: { staff: boolean }) => r.staff);
    expect(staffRow).toBeDefined();
    expect(staffRow.attemptId).toBe(built.staffAttemptId);
    expect(view.rows.filter((r: { staff: boolean }) => !r.staff)).toHaveLength(1);

    // One student out of one has finished the question, and one teacher has
    // too. Completion is 1 (not 2 / 1), and the success rate is the class's
    // zero rather than the average of 0 and 1.
    expect(view.totals[0]).toMatchObject({ completion: 1, successRate: 0 });
  });

  it("marks the entry in the grading panel", async () => {
    const built = await graded();
    const queue = (
      await get(
        `/app/api/evaluations/${built.world.seed.evaluationId}/grading?anonymous=0`,
        teacher.headers,
      )
    ).json();
    const entries = queue.entries as { attemptId: string; staff: boolean }[];
    expect(entries.find((e) => e.attemptId === built.staffAttemptId)?.staff).toBe(true);
    expect(entries.find((e) => e.attemptId === built.studentAttemptId)?.staff).toBe(false);
  });

  it("lists the row in the results, out of the statistics, out of the CSV", async () => {
    const built = await graded();
    const db = server.app.db;
    const evaluation = await reload(db, built.world.seed.evaluationId);
    const view = await resultsService.resultsView(db, evaluation);

    const staffRow = view.rows.find((r) => r.staff);
    expect(staffRow?.attemptId).toBe(built.staffAttemptId);
    expect(staffRow?.points).toBe(1);

    // One student, who scored nothing: the mean is that student's grade and
    // not the average of a 1.0 and a 6.0.
    expect(view.stats.count).toBe(1);
    expect(view.stats.mean).toBe(view.rows.find((r) => !r.staff)!.grade);
    // The success rate of the question is the class's, not 50 %.
    expect(view.items[0]!.successRate).toBe(0);

    const csv = resultsCsv(view);
    expect(csv).not.toContain(staffRow!.email);
    expect(csv).toContain(view.rows.find((r) => !r.staff)!.email);

    // And the frozen snapshot of a release holds the class, nothing else.
    const closed = await service.closeEvaluation(db, evaluation, server.clock.now());
    const released = await resultsService.releaseResults(db, closed, server.clock.now());
    expect(released.rows).toBe(1);
  });

  it("keeps a staff seat that never took the evaluation out of every list", async () => {
    const world = await running();
    await post(`/app/api/classrooms/${world.seed.classroomId}/self-enroll`, teacher.headers);
    const view = (
      await get(`/app/api/evaluations/${world.seed.evaluationId}/dashboard`, teacher.headers)
    ).json();
    expect(view.rows.some((r: { staff: boolean }) => r.staff)).toBe(false);
  });

  it("leaves the lobby denominator to the class", async () => {
    const db = server.app.db;
    const world = await running();
    await walkAsStaff(world);
    expect(await service.enrolledCount(db, world.seed.classroomId)).toBe(1);
  });
});
