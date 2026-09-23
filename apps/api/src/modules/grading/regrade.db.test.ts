/**
 * Manual override and regrade over the REAL application (PLAN-MVP §8, WP6):
 * the whole plugin chain, the real guards, the real session cookies.
 *
 * The two rules this file exists to hold are the ones a teacher will be held
 * to afterwards: an override cannot be silent (F-GRADE-05), and a correction
 * that lands after the results were published marks the evaluation
 * "modified after publication" (F-GRADE-09).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { answers, evaluations, gradings } from "../../db/schema.js";
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

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  other = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({
    method: "POST",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });

/** A closed, graded evaluation: one student, one question, a wrong answer. */
async function graded() {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 1,
  });
  const now = server.clock.now();
  let evaluation = (await applyState(db, (await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.id, seed.evaluationId))
    .limit(1))[0]!, "running", now));
  const items = await joinedItems(db, evaluation.id);
  const participant = (await live.participantOf(db, evaluation, student.id))!;
  const created = await live.ensureAttempt(db, evaluation, participant, now);
  const attempt = await live.beginAttempt(db, evaluation, created, participant, now);
  await live.saveAnswer(db, {
    evaluation,
    attempt,
    itemId: items[0]!.item.id,
    payload: "wrong",
    revision: 1,
    now,
  });
  // The route the teacher presses; `JOBS_DISABLED=1` in the test server, so
  // the pass runs inline and the gradings are there when it answers.
  const closed = await post(`/app/api/evaluations/${evaluation.id}/close`, teacher.headers, {
    confirm: true,
  });
  expect(closed.statusCode).toBe(200);
  evaluation = (await db.select().from(evaluations).where(eq(evaluations.id, evaluation.id)))[0]!;
  const [answer] = await db.select().from(answers).where(eq(answers.attemptId, attempt.id));
  return { seed, evaluation, items, attempt, answer: answer! };
}

describe("manual override (F-GRADE-05)", () => {
  it("refuses an override without a comment, and records one with", async () => {
    const { answer } = await graded();

    const silent = await post(`/app/api/answers/${answer.id}/gradings`, teacher.headers, {
      points: 1,
    });
    expect(silent.statusCode).toBe(400);

    const blank = await post(`/app/api/answers/${answer.id}/gradings`, teacher.headers, {
      points: 1,
      comment: "   ",
    });
    expect(blank.statusCode).toBe(400);

    const ok = await post(`/app/api/answers/${answer.id}/gradings`, teacher.headers, {
      points: 0.5,
      comment: "half a point: the reasoning was right",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ points: 0.5, source: "manual", state: "validated" });

    const history = await get(`/app/api/answers/${answer.id}/gradings`, teacher.headers);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(2);
    expect(history.json()[0]).toMatchObject({ state: "validated", source: "manual" });
    expect(history.json()[1]).toMatchObject({ state: "superseded" });
  });

  it("answers 404, not 403, to a teacher of another course", async () => {
    const { evaluation, answer } = await graded();
    const forbidden = await post(`/app/api/answers/${answer.id}/gradings`, other.headers, {
      points: 1,
      comment: "not mine",
    });
    expect(forbidden.statusCode).toBe(404);

    const panel = await get(`/app/api/evaluations/${evaluation.id}/grading`, other.headers);
    expect(panel.statusCode).toBe(404);

    // A student never reaches the teacher surface at all.
    const asStudent = await get(`/app/api/evaluations/${evaluation.id}/grading`, student.headers);
    expect(asStudent.statusCode).toBe(403);
  });
});

describe("regrade (F-GRADE-06, F-GRADE-09)", () => {
  it("stamps the note, supersedes the old grading and flips the release flag", async () => {
    const db = server.app.db;
    const { evaluation, items, attempt } = await graded();

    const released = await post(`/app/api/evaluations/${evaluation.id}/release`, teacher.headers, {
      confirm: true,
    });
    expect(released.statusCode).toBe(200);
    const afterRelease = (
      await db.select().from(evaluations).where(eq(evaluations.id, evaluation.id))
    )[0]!;
    expect(afterRelease.releasedAt).not.toBeNull();
    expect(afterRelease.modifiedAfterRelease).toBe(false);

    const regraded = await post(
      `/app/api/evaluations/${evaluation.id}/items/${items[0]!.item.id}/regrade`,
      teacher.headers,
      { note: "the key was wrong" },
    );
    expect(regraded.statusCode).toBe(202);

    const rows = await db.select().from(gradings).where(eq(gradings.attemptId, attempt.id));
    const standing = rows.filter((r) => r.state !== "superseded");
    expect(standing).toHaveLength(1);
    expect(standing[0]!.regradeNote).toBe("the key was wrong");
    expect(rows.filter((r) => r.state === "superseded").length).toBeGreaterThan(0);

    const flipped = (
      await db.select().from(evaluations).where(eq(evaluations.id, evaluation.id))
    )[0]!;
    expect(flipped.modifiedAfterRelease).toBe(true);
  });

  it("404s a regrade on an item that is not this evaluation's", async () => {
    const { evaluation } = await graded();
    const elsewhere = await graded();
    const wrong = await post(
      `/app/api/evaluations/${evaluation.id}/items/${elsewhere.items[0]!.item.id}/regrade`,
      teacher.headers,
      { note: "nope" },
    );
    expect(wrong.statusCode).toBe(404);
  });
});

/**
 * The order of the refusals, which the wrappers of `modules/http.ts` must
 * keep (audit B-02). The cell and regrade routes validate their body BEFORE
 * loading their scope; the evaluation-wide ones load their scope first.
 */
describe("the order of the refusals, over HTTP", () => {
  it("refuses session, params, then body and scope in each route's own order", async () => {
    const { evaluation, items, answer } = await graded();
    const badBody = { points: "many" };

    expect((await post(`/app/api/answers/x/gradings`, {}, badBody)).statusCode).toBe(401);
    expect((await post(`/app/api/answers/x/gradings`, student.headers, badBody)).statusCode).toBe(403);
    const badParams = await post(`/app/api/answers/x/gradings`, teacher.headers, badBody);
    expect(badParams.statusCode).toBe(404);
    expect(badParams.json()).toEqual({ error: "not_found" });

    // Body first: a malformed override is a 400 even off the staff.
    const bodyFirst = await post(`/app/api/answers/${answer.id}/gradings`, other.headers, badBody);
    expect(bodyFirst.statusCode).toBe(400);
    expect(bodyFirst.json().error).toBe("validation");
    const regrade = await post(
      `/app/api/evaluations/${evaluation.id}/items/${items[0]!.item.id}/regrade`,
      other.headers,
      {},
    );
    expect(regrade.statusCode).toBe(400);

    // Scope first: off the staff, the 404 wins over the malformed body.
    const scopeFirst = await post(
      `/app/api/evaluations/${evaluation.id}/grading/validate-batch`,
      other.headers,
      { state: "validated" },
    );
    expect(scopeFirst.statusCode).toBe(404);
    expect(scopeFirst.json()).toEqual({ error: "not_found" });
  });

  it("overrides through both entry points and maps the module's refusals", async () => {
    const { answer } = await graded();
    const first = await post(`/app/api/answers/${answer.id}/gradings`, teacher.headers, {
      points: 0.25,
      comment: "through the answer",
    });
    expect(first.statusCode).toBe(200);
    const gradingId = first.json().id as string;

    // Off the staff, a well-formed override of the grading is a 404.
    const foreign = await post(`/app/api/gradings/${gradingId}/override`, other.headers, {
      points: 1,
      comment: "not mine",
    });
    expect(foreign.statusCode).toBe(404);

    const second = await post(`/app/api/gradings/${gradingId}/override`, teacher.headers, {
      points: 0.75,
      comment: "through the grading",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ points: 0.75, source: "manual", state: "validated" });

    // A validated grading is no proposal: `NotPending` comes back as its own 409.
    const again = await post(`/app/api/gradings/${second.json().id}/validate`, teacher.headers);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error: "not_pending",
      message: "this grading is not a proposal any more",
    });
  });
});
