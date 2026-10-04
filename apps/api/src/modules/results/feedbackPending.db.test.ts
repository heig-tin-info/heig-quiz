/**
 * What a student reads of an attempt whose cells are not all graded yet
 * (F-RES-04): the validated points, how many questions are still pending,
 * and no grade — a pending cell is not a zero. An exercise shows points
 * alone before its release; an exam shows nothing before its close, even
 * under a legacy `immediate` policy (`feedbackGate`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationMode } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluations } from "../../db/schema.js";
import { testDatabase } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { evaluationRows } from "../../test/grades.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;
const now = new Date("2026-09-20T09:00:00.000Z");

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  ({ db } = await testDatabase());
});
afterAll(() => restore());

/**
 * A running evaluation of three questions under `immediate` (written
 * directly for an exam: the legacy row the contracts now refuse), and one
 * student's attempt, answered and handed in.
 */
async function handedIn(mode: EvaluationMode) {
  const seed = await seedLive(db, {
    students: 1,
    questions: 3,
    mode,
    ...(mode === "exercise"
      ? { durationS: null, settings: { timing: "manual", lobby: "skip" } }
      : {}),
  });
  await db
    .update(evaluations)
    .set({
      feedbackPolicy: {
        when: "immediate",
        showAnswer: true,
        showKey: true,
        showExplanation: false,
        showHiddenCaseNames: false,
        showTeacherComment: true,
      },
    })
    .where(eq(evaluations.id, seed.evaluationId));
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", now);
  const items = await joinedItems(db, evaluation.id);
  const studentId = seed.studentIds[0]!;
  const participant = (await live.participantOf(db, evaluation, studentId))!;
  const created = await live.ensureAttempt(db, evaluation, participant, now);
  const attempt = await live.beginAttempt(db, evaluation, created, participant, now);
  for (const [index, item] of items.entries()) {
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: item.item.id,
      payload: `answer-q${index}`,
      revision: 1,
      now,
    });
  }
  const submitted = await live.submitAttempt(db, evaluation, attempt, now);
  return { evaluationId: evaluation.id, items, attempt: submitted, studentId };
}

/** One cell's grading: `validated` counts, `proposed` (a runner, an LLM) does not. */
async function grade(
  built: Awaited<ReturnType<typeof handedIn>>,
  index: number,
  points: number,
  state: "validated" | "proposed" = "validated",
) {
  const item = built.items[index]!.item;
  await grading.writeGrading(db, {
    attemptId: built.attempt.id,
    itemId: item.id,
    answerId: null,
    points,
    maxPoints: item.points,
    source: state === "validated" ? "manual" : "auto",
    state,
    details: { manual: true },
    now,
  });
}

async function feedbackOf(built: Awaited<ReturnType<typeof handedIn>>) {
  const attempt = (await live.attemptById(db, built.attempt.id))!;
  return service.studentFeedback(db, await reload(db, built.evaluationId), attempt, now);
}

describe("pending cells on the student's feedback (F-RES-04)", () => {
  it("an exercise: the validated points and the pending count, never a grade before release", async () => {
    const built = await handedIn("exercise");
    const total = built.items.reduce((sum, i) => sum + i.item.points, 0);
    await grade(built, 0, built.items[0]!.item.points);
    // A proposal is not a grade: the cell stays pending.
    await grade(built, 1, 0, "proposed");

    const page = await feedbackOf(built);
    if (!page.available) throw new Error(`unavailable: ${page.reason}`);
    expect(page.grade).toBeNull();
    expect(page.points).toBe(built.items[0]!.item.points);
    expect(page.totalPoints).toBe(total);
    expect(page.pendingCount).toBe(2);
    expect(page.items.map((i) => i.points)).toEqual([built.items[0]!.item.points, null, null]);

    // The Grades page repeats exactly those points, and the same count.
    const [row] = evaluationRows(await live.studentGrades(db, built.studentId, now));
    expect(row).toMatchObject({
      status: "available",
      score: { points: built.items[0]!.item.points, totalPoints: total, grade: null, pendingCount: 2 },
    });

    // Every cell validated: still points only, the exercise is not released.
    await grade(built, 1, 0);
    await grade(built, 2, 0);
    const graded = await feedbackOf(built);
    if (!graded.available) throw new Error("unreachable");
    expect(graded.pendingCount).toBe(0);
    expect(graded.grade).toBeNull();
  });

  it("an exercise released with every cell validated carries its grade", async () => {
    const built = await handedIn("exercise");
    for (const [index, item] of built.items.entries()) await grade(built, index, item.item.points);
    const evaluation = await live.closeEvaluation(db, await reload(db, built.evaluationId), now);
    await service.releaseResults(db, evaluation, now);

    const page = await feedbackOf(built);
    if (!page.available) throw new Error("unreachable");
    expect(page.pendingCount).toBe(0);
    expect(page.grade).toBe(6);
  });

  it("an exam under a legacy immediate policy: nothing before the close", async () => {
    const built = await handedIn("exam");
    await grade(built, 0, built.items[0]!.item.points);

    expect(await feedbackOf(built)).toEqual({
      available: false,
      reason: "exam_open",
      evaluation: { id: built.evaluationId, title: expect.any(String) },
    });
    // The drill's key follows the same gate.
    expect(service.keyShownTo(await reload(db, built.evaluationId), "submitted")).toBe(false);
    const [row] = evaluationRows(await live.studentGrades(db, built.studentId, now));
    expect(row).toMatchObject({ status: "pending", score: null, feedbackAttemptId: null });

    // Closed: the policy applies — the validated points, no grade while pending.
    await live.closeEvaluation(db, await reload(db, built.evaluationId), now);
    const closed = await feedbackOf(built);
    if (!closed.available) throw new Error(`unavailable: ${closed.reason}`);
    expect(closed.pendingCount).toBe(2);
    expect(closed.grade).toBeNull();
    expect(closed.points).toBe(built.items[0]!.item.points);
    expect(service.keyShownTo(await reload(db, built.evaluationId), "submitted")).toBe(true);
  });
});
