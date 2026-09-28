/**
 * `grading_ready` (ADR-030, addendum §c; #198 step 5): the staff hear once
 * that the automatic grading of an evaluation is finished and proposals
 * remain — once per grading pass, never per cell, never for a pass that
 * settled everything, and never twice for a pass run again with nothing new.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, courseStaff, evaluations, notifications, users } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { runEvaluationGrading } from "./jobs.js";
import { announceGradingReady } from "./ready.js";
import { regradeItem } from "./service.js";

let db: Db;
const restores: (() => void)[] = [];

beforeAll(async () => {
  restores.push(registerForTests(fakeShort));
  db = await testDb();
});
afterAll(() => {
  for (const restore of restores) restore();
});

async function appFor() {
  const app = await testApp(db);
  app.clock.set("2026-09-20T09:00:00.000Z");
  return app;
}

async function makeUser(role: "teacher" | "admin" | "student"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `s-${id}`, email: `${role}-${id.slice(0, 8)}@heig.test`, role });
  return id;
}

/**
 * A closed evaluation, two students, two questions; every answer is right
 * unless `broken`, whose first answer is corrupted into a payload the type
 * refuses — which the pass turns into a PROPOSAL (`answer_invalid`).
 * A colleague holds a second seat on the course; an admin holds none.
 */
async function closedEvaluation(broken: boolean) {
  const app = await appFor();
  const seed = await seedLive(db, { students: 2, questions: 2 });
  const colleague = await makeUser("teacher");
  await db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague });
  const admin = await makeUser("admin");
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  for (const userId of seed.studentIds) {
    app.clock.advance(1);
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, item] of items.entries()) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        payload: `answer-q${index}`,
        revision: 1,
        now: app.clock.now(),
      });
    }
  }
  if (broken) {
    await db
      .update(answers)
      .set({ payload: { not: "a string" } })
      .where(
        and(
          eq(answers.itemId, items[0]!.item.id),
          sql`${answers.attemptId} in (select id from attempts where user_id = ${seed.studentIds[0]!})`,
        ),
      );
  }
  evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
  return { app, seed, evaluation, items, colleague, admin };
}

const readyRows = (evaluationId: string) =>
  db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.evaluationId, evaluationId),
        sql`${notifications.payload}->>'kind' = 'grading_ready'`,
      ),
    );

describe("grading_ready", () => {
  it("tells every staff seat once when the pass leaves proposals, with a count and nothing else", async () => {
    const { app, seed, evaluation, colleague, admin } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id, announce: true });

    const rows = await readyRows(evaluation.id);
    expect(rows.map((r) => r.userId).sort()).toEqual([seed.teacherId, colleague].sort());
    // Not a seatless admin, not a student.
    expect(rows.some((r) => r.userId === admin || seed.studentIds.includes(r.userId))).toBe(false);
    for (const row of rows) {
      expect(row.payload).toEqual({
        kind: "grading_ready",
        evaluationId: evaluation.id,
        evaluationTitle: evaluation.title,
        count: 1,
      });
    }
    // No grade, no name, no answer anywhere in what leaves the platform.
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).not.toMatch(/points|grade|Prenom|Nom|answer-q|@heig/);
  });

  it("says nothing when the pass settled every cell", async () => {
    const { app, evaluation } = await closedEvaluation(false);
    await runEvaluationGrading(app, { evaluationId: evaluation.id, announce: true });
    expect(await readyRows(evaluation.id)).toEqual([]);
  });

  it("says nothing again when the pass runs again with nothing new", async () => {
    const { app, evaluation } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id, announce: true });
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(await readyRows(evaluation.id)).toHaveLength(2);
  });

  it("tells again after a re-grade whose pass leaves proposals: a new pass, new cells", async () => {
    const { app, evaluation, items } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id, announce: true });
    const item = items[0]!;
    await regradeItem(db, { itemId: item.item.id, questionId: item.question.id }, { note: "typo" });
    await runEvaluationGrading(app, {
      evaluationId: evaluation.id,
      itemIds: [item.item.id],
      regradeNote: "typo",
    });
    expect(await readyRows(evaluation.id)).toHaveLength(4);
  });

  it("waits for the runner: the job that fills the last cell tells, once", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      // No queue here, so the runner job runs inline — AFTER the pass wrote
      // its batch, as a queued one would.
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId, announce: true });
      const rows = await readyRows(fixture.evaluationId);
      expect(rows.map((r) => r.userId)).toEqual([fixture.teacherId]);
      expect(rows[0]!.payload).toMatchObject({ count: 1 });

      // The runner cell already holds a proposal: re-sent, it completes nothing.
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });
      expect(await readyRows(fixture.evaluationId)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("says nothing while the evaluation runs (a retake graded alone)", async () => {
    const { app, evaluation } = await closedEvaluation(true);
    // The state an exercise with retakes is in when one attempt is graded alone.
    await db.update(evaluations).set({ state: "running" }).where(eq(evaluations.id, evaluation.id));
    await runEvaluationGrading(app, { evaluationId: evaluation.id, announce: true });
    expect(await readyRows(evaluation.id)).toEqual([]);
  });

  it("reads the state NOW: a job that loaded the evaluation while it ran still tells after the close", async () => {
    const { app, seed, evaluation } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await db.delete(notifications).where(eq(notifications.evaluationId, evaluation.id));
    // The row a runner job picked up before the close.
    await announceGradingReady(app, { ...evaluation, state: "running" });
    expect((await readyRows(evaluation.id)).map((r) => r.userId)).toContain(seed.teacherId);
  });
});
