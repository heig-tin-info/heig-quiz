/**
 * `grading_ready` (ADR-030, addendum §c; #198 step 5): the staff hear once
 * that the automatic grading of an evaluation is finished and proposals
 * remain — once per completed grid (#286), never per cell, never for a pass
 * that settled everything, and never twice for a pass run again with nothing
 * new, nor for a runner job racing a pass.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  answers,
  attempts,
  courseStaff,
  evaluations,
  gradings,
  notifications,
  users,
} from "../../db/schema.js";
import { InProcessQueue } from "../../jobs.js";
import { testApp, testDb } from "../../test/db.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { enqueueEvaluationGrading, registerGradingJobs, runEvaluationGrading } from "./jobs.js";
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
    await runEvaluationGrading(app, { evaluationId: evaluation.id });

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
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(await readyRows(evaluation.id)).toEqual([]);
  });

  it("says nothing again when the pass runs again with nothing new", async () => {
    const { app, evaluation } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(await readyRows(evaluation.id)).toHaveLength(2);
  });

  it("tells again after a re-grade whose pass leaves proposals: a new pass, new cells", async () => {
    const { app, evaluation, items } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const item = items[0]!;
    await regradeItem(
      db,
      { evaluationId: evaluation.id, itemId: item.item.id, questionId: item.question.id, variables: null },
      { note: "typo" },
    );
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
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });
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

  it("gives the claim back on a reopening to draft, so a new close tells again", async () => {
    const { app, evaluation } = await closedEvaluation(true);
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect((await reload(db, evaluation.id)).gradingReadyAt).not.toBeNull();

    const draft = await applyState(db, await reload(db, evaluation.id), "draft", app.clock.now());
    expect(draft.gradingReadyAt).toBeNull();
    const running = await applyState(db, draft, "running", app.clock.now());
    await applyState(db, running, "closed", app.clock.now());
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(await readyRows(evaluation.id)).toHaveLength(4);
  });

  it("says nothing while the evaluation runs (a retake graded alone)", async () => {
    const { app, evaluation } = await closedEvaluation(true);
    // The state an exercise with retakes is in when one attempt is graded alone.
    await db.update(evaluations).set({ state: "running" }).where(eq(evaluations.id, evaluation.id));
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(await readyRows(evaluation.id)).toEqual([]);
  });

  it("reads the state NOW: a job that loaded the evaluation while it ran still tells after the close", async () => {
    const { app, seed, evaluation } = await closedEvaluation(true);
    // Graded while it ran (a retake alone): nobody is told, nothing claimed.
    await db.update(evaluations).set({ state: "running" }).where(eq(evaluations.id, evaluation.id));
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await db.update(evaluations).set({ state: "closed" }).where(eq(evaluations.id, evaluation.id));
    expect(await readyRows(evaluation.id)).toEqual([]);
    // The row a runner job picked up before the close.
    await announceGradingReady(app, { ...evaluation, state: "running" });
    expect((await readyRows(evaluation.id)).map((r) => r.userId)).toContain(seed.teacherId);
  });

  describe("through the in-process queue (#273)", () => {
    /** The closed evaluation, its two attempts, and an app whose passes go through a real queue. */
    async function queuedFixture() {
      const fixture = await closedEvaluation(true);
      const queue = new InProcessQueue(true, fixture.app.log);
      const queued = Object.assign(Object.create(fixture.app), { boss: queue }) as typeof fixture.app;
      await registerGradingJobs(queued, queue);
      // A job on its own queue, sent last: the queue is FIFO, so once it has
      // run, every pass sent before it has run too. A barrier for the PASSES
      // only: the `grading.runner` jobs they enqueue go on another queue and
      // may still be out — do not reuse it with a runner-backed question.
      const drained = () =>
        new Promise<void>((resolve) => {
          void queue.work("test.drained", async () => resolve());
          void queue.send("test.drained", {});
        });
      const [first, second] = await db
        .select()
        .from(attempts)
        .where(eq(attempts.evaluationId, fixture.evaluation.id));
      return { ...fixture, queued, drained, first: first!, second: second! };
    }

    it("never loses the close's pass behind a retake pass still waiting", async () => {
      const { seed, evaluation, colleague, queued, drained, second, first } = await queuedFixture();
      // A retake pass running, the same one sent again and still waiting, then
      // the close's whole-evaluation pass: the last one used to be dropped,
      // leaving the other attempt ungraded and the staff untold.
      const retake = { evaluationId: evaluation.id, attemptIds: [first.id] };
      await enqueueEvaluationGrading(queued, retake);
      await enqueueEvaluationGrading(queued, retake);
      await enqueueEvaluationGrading(queued, { evaluationId: evaluation.id });
      await drained();

      const graded = await db.select().from(gradings).where(eq(gradings.attemptId, second.id));
      expect(graded.length).toBeGreaterThan(0);
      expect((await readyRows(evaluation.id)).map((r) => r.userId).sort()).toEqual(
        [seed.teacherId, colleague].sort(),
      );
    });

    it("tells once when a retake pass completes the grid after the close, ahead of the close's pass", async () => {
      const { app, seed, evaluation, colleague, queued, drained, first, second } =
        await queuedFixture();
      // Student A's retake was graded while the evaluation ran; student B's
      // retake pass was sent then too, but runs only after the close.
      await runEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds: [first.id] });
      await enqueueEvaluationGrading(queued, {
        evaluationId: evaluation.id,
        attemptIds: [second.id],
      });
      await enqueueEvaluationGrading(queued, { evaluationId: evaluation.id });
      await drained();

      expect((await readyRows(evaluation.id)).map((r) => r.userId).sort()).toEqual(
        [seed.teacherId, colleague].sort(),
      );
    });
  });

  describe("a runner job racing a pass (#286)", () => {
    /**
     * A closed evaluation with one unanswered `short` cell (Y), which a pass
     * settles itself, and one `code` cell (X), which only a runner job fills.
     * Under the stub runner X ends as a proposal: the grid, once complete,
     * has exactly one.
     */
    async function raceFixture() {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now(), { shortQuestions: 1 });
      const short = (await joinedItems(db, fixture.evaluationId)).find(
        (i) => i.item.id !== fixture.itemId,
      )!;
      return { app, fixture, shortItemId: short.item.id };
    }

    it("tells once when a runner job completes the grid between the close and its pass", async () => {
      const restore = registerForTests(fakeRunnableCode);
      try {
        const { app, fixture, shortItemId } = await raceFixture();
        // Y was settled by an earlier (retake) pass; X's runner job lands
        // after the flip to closed and fills the last cell...
        await runEvaluationGrading(app, { evaluationId: fixture.evaluationId, itemIds: [shortItemId] });
        await runEvaluationGrading(app, { evaluationId: fixture.evaluationId, itemIds: [fixture.itemId] });
        expect(await readyRows(fixture.evaluationId)).toHaveLength(1);
        // ...and the close's own pass comes after it: nothing new to tell.
        await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });
        expect(await readyRows(fixture.evaluationId)).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("tells once when a runner job fills a cell inside a pass's read-to-write window", async () => {
      // The pass reads the grid with X empty; X's runner job (sent by an
      // earlier pass) then runs to its end — it finds Y still empty, the pass
      // not having written — before the pass writes Y and re-sends X, whose
      // new job finds X already graded. Driven in that order, deterministically:
      // the pass's own call to `grade` on X is where the other job runs.
      let inWindow: (() => Promise<void>) | null = null;
      const restore = registerForTests({
        ...fakeRunnableCode,
        async grade(config, answer, ctx) {
          const hook = inWindow;
          inWindow = null;
          if (hook) await hook();
          return fakeRunnableCode.grade(config, answer, ctx);
        },
      });
      try {
        const { app, fixture } = await raceFixture();
        inWindow = () =>
          runEvaluationGrading(app, { evaluationId: fixture.evaluationId, itemIds: [fixture.itemId] });
        await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });

        const rows = await readyRows(fixture.evaluationId);
        expect(rows.map((r) => r.userId)).toEqual([fixture.teacherId]);
        expect(rows[0]!.payload).toMatchObject({ count: 1 });
      } finally {
        restore();
      }
    });
  });
});
