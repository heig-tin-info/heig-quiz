/**
 * The HTTP surface of the `grading` and `results` modules over the REAL
 * application (PLAN-MVP §4.5, §4.6).
 *
 * The service tests next to this file own the rules; this one owns the
 * contract: paths, status codes, the CSV headers, and the 404-not-403 rule
 * for anyone the evaluation does not belong to (invariant 6).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { evaluations } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let other: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let built: Awaited<ReturnType<typeof closedEvaluation>>;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  other = await server.signIn("teacher");
  student = await server.signIn("student");
  built = await closedEvaluation();
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({
    method: "POST",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });

/** One student, one right answer, closed through the real route. */
async function closedEvaluation() {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 1,
  });
  const now = server.clock.now();
  const row = (await db.select().from(evaluations).where(eq(evaluations.id, seed.evaluationId)))[0]!;
  const evaluation = await applyState(db, row, "running", now);
  const items = await joinedItems(db, evaluation.id);
  const participant = (await live.participantOf(db, evaluation, student.id))!;
  const created = await live.ensureAttempt(db, evaluation, participant, now);
  const attempt = await live.beginAttempt(db, evaluation, created, participant, now);
  await live.saveAnswer(db, {
    evaluation,
    attempt,
    itemId: items[0]!.item.id,
    payload: "answer-q0",
    revision: 1,
    now,
  });
  await post(`/app/api/evaluations/${evaluation.id}/close`, teacher.headers, { confirm: true });
  return { seed, evaluationId: evaluation.id, itemId: items[0]!.item.id, attemptId: attempt.id };
}

describe("the grading panel (§4.5)", () => {
  it("serves the queue by question, pseudonymous by default", async () => {
    const anonymous = await get(
      `/app/api/evaluations/${built.evaluationId}/grading`,
      teacher.headers,
    );
    expect(anonymous.statusCode).toBe(200);
    const queue = anonymous.json();
    expect(queue.order).toBe("question");
    expect(queue.entries).toHaveLength(1);
    expect(queue.counts).toMatchObject({ total: 1, validated: 1, proposed: 0, missing: 0 });
    // A pseudonym, never the name (F-GRADE-03, decision D20).
    expect(queue.entries[0].label).not.toContain("Test");

    const named = await get(
      `/app/api/evaluations/${built.evaluationId}/grading?anonymous=0&by=student`,
      teacher.headers,
    );
    expect(named.json().order).toBe("student");
    expect(named.json().entries[0].label).not.toBe(queue.entries[0].label);
  });

  it("reports progress and re-runs on demand", async () => {
    const progress = await get(
      `/app/api/evaluations/${built.evaluationId}/grading/progress`,
      teacher.headers,
    );
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ done: 1, total: 1, failed: 0 });

    const rerun = await post(`/app/api/evaluations/${built.evaluationId}/grading/run`, teacher.headers, {});
    expect(rerun.statusCode).toBe(202);
    expect(rerun.json()).toMatchObject({ evaluationId: built.evaluationId });
  });

  it("answers 404 to a teacher of another course and 403 to a student", async () => {
    expect((await get(`/app/api/evaluations/${built.evaluationId}/grading`, other.headers)).statusCode).toBe(404);
    expect((await get(`/app/api/evaluations/${built.evaluationId}/results`, other.headers)).statusCode).toBe(404);
    expect(
      (await post(`/app/api/evaluations/${built.evaluationId}/release`, other.headers, { confirm: true }))
        .statusCode,
    ).toBe(404);
    expect((await get(`/app/api/evaluations/${built.evaluationId}/results`, student.headers)).statusCode).toBe(403);
  });
});

describe("results and the export (§4.6)", () => {
  it("serves the grade table, the per-question view and the CSV", async () => {
    const view = await get(`/app/api/evaluations/${built.evaluationId}/results`, teacher.headers);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ released: false, totalPoints: 1 });
    expect(view.json().rows).toHaveLength(1);
    expect(view.json().rows[0]).toMatchObject({ points: 1, grade: 6 });

    const byQuestion = await get(
      `/app/api/evaluations/${built.evaluationId}/results/by-question`,
      teacher.headers,
    );
    expect(byQuestion.statusCode).toBe(200);
    expect(byQuestion.json()[0]).toMatchObject({ answered: 1, successRate: 1 });
    expect(byQuestion.json()[0].distribution[0]).toMatchObject({ key: "answer-q0", count: 1 });

    const csv = await get(`/app/api/evaluations/${built.evaluationId}/results.csv`, teacher.headers);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.payload).toContain(";");
  });

  it("gates the student's feedback on the release", async () => {
    const before = await get(`/app/api/attempts/${built.attemptId}/feedback`, student.headers);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ available: false, reason: "results_pending" });

    const cards = await get("/app/api/student/results", student.headers);
    expect(cards.json()).toHaveLength(0);

    const released = await post(
      `/app/api/evaluations/${built.evaluationId}/release`,
      teacher.headers,
      { confirm: true },
    );
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ rows: 1, released: true });

    const after = await get(`/app/api/attempts/${built.attemptId}/feedback`, student.headers);
    expect(after.json()).toMatchObject({ available: true, points: 1, grade: 6 });
    const cardsAfter = await get("/app/api/student/results", student.headers);
    expect(cardsAfter.json()).toHaveLength(1);
    expect(cardsAfter.json()[0]).toMatchObject({ grade: 6, totalPoints: 1 });

    // The student home carries the grade too (WP5 placeholder, filled here).
    const home = await get("/app/api/student/home", student.headers);
    expect(home.json().past[0]).toMatchObject({ grade: 6 });

    // Another student never reaches this attempt.
    const stranger = await server.signIn("student");
    expect(
      (await get(`/app/api/attempts/${built.attemptId}/feedback`, stranger.headers)).statusCode,
    ).toBe(404);
  });
});

/**
 * The order of the refusals, which the wrappers of `modules/http.ts` must
 * keep (audit B-02): session and role (the preHandler) → params (404) →
 * scope (the loader's 404) → body (400) → the module's error map.
 */
describe("the order of the refusals, over HTTP", () => {
  it("refuses session, params, scope, body, then maps the service error", async () => {
    const url = `/app/api/evaluations/${built.evaluationId}/release`;
    expect((await post("/app/api/evaluations/x/release", {}, {})).statusCode).toBe(401);
    expect((await post("/app/api/evaluations/x/release", student.headers, {})).statusCode).toBe(403);
    const badParams = await post("/app/api/evaluations/x/release", teacher.headers, { confirm: "no" });
    expect(badParams.statusCode).toBe(404);
    expect(badParams.json()).toEqual({ error: "not_found" });

    // Off the staff, the scope's 404 wins over the malformed body.
    const offStaff = await post(url, other.headers, { confirm: "no" });
    expect(offStaff.statusCode).toBe(404);
    expect(offStaff.json()).toEqual({ error: "not_found" });

    const malformed = await post(url, teacher.headers, { confirm: "no" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("validation");

    // An evaluation that is not closed cannot be released: `NotReleasable`'s own 409.
    const open = await seedLive(server.app.db, { teacherId: teacher.id, questions: 1 });
    const early = await post(`/app/api/evaluations/${open.evaluationId}/release`, teacher.headers, {
      confirm: true,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({
      error: "not_releasable",
      message: "an evaluation is released once it is closed",
    });

    // The student route: bad params are a 404 before any attempt is looked up.
    const feedback = await get("/app/api/attempts/x/feedback", student.headers);
    expect(feedback.statusCode).toBe(404);
    expect(feedback.json()).toEqual({ error: "not_found" });
  });
});
