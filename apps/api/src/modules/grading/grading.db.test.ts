/**
 * The grading job and the panel against the real migrations (PLAN-MVP §8,
 * WP6).
 *
 * The job is exercised by calling its handler directly: no queue, no timer,
 * no sleep. Everything it depends on — the clock, the runner — is an object
 * the test hands over, which is what makes "the stub degrades to a proposal"
 * and "a real runner validates" two lines apart.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerOutcome, RunnerService } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, attempts, gradings } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { testApp, testDb, type TestDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, byId, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { runEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";

let raw: TestDb;
let db: Db;
const restores: (() => void)[] = [];

beforeAll(async () => {
  restores.push(registerForTests(fakeShort));
  raw = await testDb();
  db = raw as unknown as Db;
});
afterAll(() => {
  for (const restore of restores) restore();
});

/** An app whose db is the shared one; `boss` is null, so jobs run inline. */
async function appFor() {
  const app = await testApp(raw);
  app.clock.set("2026-09-20T09:00:00.000Z");
  return app;
}

/**
 * A closed evaluation whose two students answered the first question (one
 * right, one wrong) and left the second one untouched.
 */
async function closedEvaluation(options: Parameters<typeof seedLive>[1] = {}) {
  const app = await appFor();
  const seed = await seedLive(db, { students: 2, questions: 2, ...options });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);

  const attemptRows = [];
  for (const [index, userId] of seed.studentIds.entries()) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[0]!.item.id,
      // The fake `short` type matches `answer-q0` exactly.
      payload: index === 0 ? "answer-q0" : "nope",
      revision: 1,
      now: app.clock.now(),
    });
    attemptRows.push(attempt);
  }
  evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
  return { app, seed, evaluation, items, attempts: attemptRows };
}

const gradingsOf = (evaluationId: string) =>
  db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(eq(attempts.evaluationId, evaluationId));

describe("grading.evaluation (F-GRADE-01, §5.4)", () => {
  it("grades every cell once, and running it twice writes nothing more", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const first = await gradingsOf(evaluation.id);
    // Two students x two questions.
    expect(first).toHaveLength(4);
    expect(first.every((r) => r.grading.state === "validated")).toBe(true);

    app.clock.advance(60_000);
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const second = await gradingsOf(evaluation.id);
    expect(second).toHaveLength(4);
    expect(new Set(second.map((r) => r.grading.id))).toEqual(
      new Set(first.map((r) => r.grading.id)),
    );

    // The right answer scores, the wrong one does not.
    const right = second.find(
      (r) => r.grading.attemptId === rows[0]!.id && r.grading.itemId === items[0]!.item.id,
    )!;
    const wrong = second.find(
      (r) => r.grading.attemptId === rows[1]!.id && r.grading.itemId === items[0]!.item.id,
    )!;
    expect(right.grading.points).toBe(items[0]!.item.points);
    expect(wrong.grading.points).toBe(0);
  });

  it("gives an absent answer zero points, validated, with no answer row", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    const [missing] = await db
      .select()
      .from(gradings)
      .where(
        and(eq(gradings.attemptId, rows[0]!.id), eq(gradings.itemId, items[1]!.item.id)),
      );
    expect(missing).toBeDefined();
    expect(missing!.answerId).toBeNull();
    expect(missing!.points).toBe(0);
    expect(missing!.state).toBe("validated");
    expect(missing!.source).toBe("auto");
    // No details at all: no question type ever ran on it, and a marker of
    // another shape is what a type's `Review` chokes on downstream.
    expect(missing!.details).toBeNull();
  });

  it("is enqueued by closing the evaluation", async () => {
    const app = await appFor();
    const seed = await seedLive(db, { students: 1, questions: 1 });
    let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    await live.beginAttempt(db, evaluation, created, participant, app.clock.now());

    // `app` handed over: closing starts the correction (§5.4).
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now(), "teacher", app);
    expect(await gradingsOf(evaluation.id)).toHaveLength(1);
  });
});

describe("progress events of the pass (§5.4)", () => {
  /** Every `grading.progress` frame published while `run` runs, as `done/total/phase`. */
  async function progressDuring(evaluationId: string, run: () => Promise<void>) {
    const frames: string[] = [];
    const stop = subscribe((message) => {
      if (message.kind !== "data" || message.event.type !== "grading.progress") return;
      if (message.event.evaluationId !== evaluationId) return;
      frames.push(`${message.event.done}/${message.event.total}/${message.event.phase}`);
    });
    try {
      await run();
    } finally {
      stop();
    }
    return frames;
  }

  it("ticks every 25 cells, on a skipped cell as on a graded one, then says it is done", async () => {
    // 13 students x 2 questions = 26 cells: one tick at 25, one final frame.
    const { app, evaluation } = await closedEvaluation({ students: 13 });
    const first = await progressDuring(evaluation.id, () =>
      runEvaluationGrading(app, { evaluationId: evaluation.id }),
    );
    expect(first).toEqual(["25/26/auto", "26/26/done"]);
    // The second pass skips every (validated) cell, and still reports.
    const second = await progressDuring(evaluation.id, () =>
      runEvaluationGrading(app, { evaluationId: evaluation.id }),
    );
    expect(second).toEqual(["25/26/auto", "26/26/done"]);
  });

  it("ends in the runner phase when a cell went to the runner", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      const frames = await progressDuring(fixture.evaluationId, () =>
        runEvaluationGrading(app, { evaluationId: fixture.evaluationId }),
      );
      expect(frames).toEqual(["1/1/runner"]);
    } finally {
      restore();
    }
  });
});

describe("the panel queue (F-GRADE-03)", () => {
  /**
   * Two students x two questions: question 0 graded (right, wrong), question
   * 1 with one standing proposal (student 0) and one cell never graded
   * (student 1). The projection names every cell `s<student>q<question>`.
   */
  async function queueFixture() {
    const fixture = await closedEvaluation();
    const { app, evaluation, items, attempts: rows } = fixture;
    await runEvaluationGrading(app, { evaluationId: evaluation.id, itemIds: [items[0]!.item.id] });
    app.clock.advance(1000);
    await service.writeGrading(db, {
      attemptId: rows[0]!.id,
      itemId: items[1]!.item.id,
      answerId: null,
      points: 0,
      maxPoints: items[1]!.item.points,
      source: "auto",
      state: "proposed",
      details: { reason: "runner_unavailable" },
      now: app.clock.now(),
    });
    const record = (await byId(db, evaluation.id))!;
    const cell = (entry: { attemptId: string; itemId: string }) =>
      `s${rows.findIndex((r) => r.id === entry.attemptId)}q${items.findIndex((i) => i.item.id === entry.itemId)}`;
    const queue = async (query: Partial<Parameters<typeof service.gradingQueue>[2]>) => {
      const result = await service.gradingQueue(db, record, {
        by: "question",
        anonymous: true,
        ...query,
      });
      return {
        order: result.order,
        items: result.items.map((i) => i.id),
        counts: result.counts,
        entries: result.entries.map(
          (e) =>
            `${cell(e)}:${e.grading?.state ?? "none"}:${e.answerId === null ? "no-answer" : "answer"}:${e.history.length}`,
        ),
        raw: result.entries,
      };
    };
    return { ...fixture, queue };
  }

  it("builds the cross product by question or by student, with the counts of the selection", async () => {
    const { items, attempts: rows, queue } = await queueFixture();

    const byQuestion = await queue({ by: "question" });
    expect(byQuestion.order).toBe("question");
    expect(byQuestion.items).toEqual(items.map((i) => i.item.id));
    expect(byQuestion.entries).toEqual([
      "s0q0:validated:answer:1",
      "s1q0:validated:answer:1",
      "s0q1:proposed:no-answer:1",
      "s1q1:none:no-answer:0",
    ]);
    expect(byQuestion.counts).toEqual({ total: 4, validated: 2, proposed: 1, missing: 1 });

    const byStudent = await queue({ by: "student" });
    expect(byStudent.entries).toEqual([
      "s0q0:validated:answer:1",
      "s0q1:proposed:no-answer:1",
      "s1q0:validated:answer:1",
      "s1q1:none:no-answer:0",
    ]);
    expect(byStudent.counts).toEqual(byQuestion.counts);

    // A filter on the state drops entries, not the counts of the selection.
    const proposed = await queue({ state: "proposed" });
    expect(proposed.entries).toEqual(["s0q1:proposed:no-answer:1"]);
    expect(proposed.counts).toEqual(byQuestion.counts);
    expect((await queue({ state: "validated" })).entries).toEqual([
      "s0q0:validated:answer:1",
      "s1q0:validated:answer:1",
    ]);

    // An item or an attempt narrows the selection, and the counts with it.
    const oneItem = await queue({ itemId: items[1]!.item.id });
    expect(oneItem.items).toEqual([items[1]!.item.id]);
    expect(oneItem.entries).toEqual(["s0q1:proposed:no-answer:1", "s1q1:none:no-answer:0"]);
    expect(oneItem.counts).toEqual({ total: 2, validated: 0, proposed: 1, missing: 1 });
    const oneAttempt = await queue({ attemptId: rows[1]!.id });
    expect(oneAttempt.entries).toEqual(["s1q0:validated:answer:1", "s1q1:none:no-answer:0"]);
    expect(oneAttempt.counts).toEqual({ total: 2, validated: 1, proposed: 0, missing: 1 });
  });

  it("labels, views and history of every entry", async () => {
    const { queue } = await queueFixture();
    const named = (await queue({ anonymous: false })).raw;
    const anonymous = (await queue({ anonymous: true })).raw;
    for (const [index, entry] of named.entries()) {
      expect(entry.label).toBe("Test student");
      expect(entry.staff).toBe(false);
      expect(entry.student).not.toBeNull();
      expect(entry.solution).not.toBeNull();
      const pseudonym = anonymous[index]!.label;
      expect(pseudonym).not.toBe("Test student");
      expect(pseudonym).not.toBe("—");
    }
    const [right] = named;
    expect(right!.answer).toBe("answer-q0");
    expect(right!.grading).toMatchObject({ state: "validated", source: "auto" });
    expect(right!.history).toEqual([
      {
        id: right!.grading!.id,
        points: right!.grading!.points,
        maxPoints: right!.grading!.maxPoints,
        source: "auto",
        state: "validated",
        gradedAt: right!.grading!.gradedAt,
        comment: null,
        regradeNote: null,
      },
    ]);
  });
});

describe("the supersede chain (F-GRADE-05)", () => {
  it("links every grading to the one it replaced and keeps one validated", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    const cell = { attemptId: rows[1]!.id, itemId: items[0]!.item.id };
    const [answer] = await db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, cell.attemptId), eq(answers.itemId, cell.itemId)));
    const automatic = (await service.standingGradings(db, evaluation.id)).get(
      service.pairKey(cell.attemptId, cell.itemId),
    )!;

    app.clock.advance(1000);
    const override = await service.manualOverride(
      db,
      { ...cell, answerId: answer!.id, maxPoints: items[0]!.item.points },
      { points: 0.5, comment: "half a point for the idea" },
      rows[0]!.userId,
      app.clock.now(),
    );

    expect(override.supersedesId).toBe(automatic.id);
    expect(override.source).toBe("manual");
    expect(override.state).toBe("validated");
    const history = await service.historyOfCell(db, cell.attemptId, cell.itemId);
    expect(history.map((h) => h.state)).toEqual(["validated", "superseded"]);
  });

  it("refuses a manual override with an empty comment", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await expect(
      service.manualOverride(
        db,
        {
          attemptId: rows[0]!.id,
          itemId: items[0]!.item.id,
          answerId: null,
          maxPoints: 1,
        },
        { points: 1, comment: "   " },
        rows[0]!.userId,
        app.clock.now(),
      ),
    ).rejects.toThrow(service.CommentRequired);
  });

  it("holds the partial unique index: two validated gradings cannot coexist", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const [answer] = await db
      .select()
      .from(answers)
      .where(
        and(
          eq(answers.attemptId, rows[0]!.id),
          eq(answers.itemId, items[0]!.item.id),
        ),
      );

    // A raw INSERT that bypasses `writeGrading` must be refused by the index.
    await expect(
      db.insert(gradings).values({
        id: randomUUID(),
        answerId: answer!.id,
        attemptId: rows[0]!.id,
        itemId: items[0]!.item.id,
        points: 1,
        maxPoints: 1,
        source: "manual",
        state: "validated",
        gradedAt: app.clock.now(),
      }),
    ).rejects.toThrow();
  });
});

describe("batch validation (F-GRADE-04)", () => {
  it("validates only the proposals the filter names", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    const now = app.clock.now();
    // Two proposals on two different items, with two confidences.
    await service.writeGrading(db, {
      attemptId: rows[0]!.id,
      itemId: items[0]!.item.id,
      answerId: null,
      points: 0,
      maxPoints: 1,
      source: "auto",
      state: "proposed",
      confidence: "high",
      details: { reason: "runner_unavailable" },
      now,
    });
    await service.writeGrading(db, {
      attemptId: rows[0]!.id,
      itemId: items[1]!.item.id,
      answerId: null,
      points: 0,
      maxPoints: 1,
      source: "auto",
      state: "proposed",
      confidence: "low",
      details: { reason: "runner_unavailable" },
      now,
    });

    const byItem = await service.batchValidate(
      db,
      evaluation.id,
      { itemId: items[0]!.item.id },
      rows[0]!.userId,
      now,
    );
    expect(byItem).toBe(1);

    const byConfidence = await service.batchValidate(
      db,
      evaluation.id,
      { confidence: "high" },
      rows[0]!.userId,
      now,
    );
    // The high-confidence one is already validated; nothing is left.
    expect(byConfidence).toBe(0);

    const rest = await service.batchValidate(db, evaluation.id, {}, rows[0]!.userId, now);
    expect(rest).toBe(1);
  });
});

describe("runner-backed grading (decision D14)", () => {
  it("degrades to a proposal with reason runner_unavailable under the stub", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });

      const rows = await gradingsOf(fixture.evaluationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.grading.state).toBe("proposed");
      expect(rows[0]!.grading.points).toBe(0);
      expect(service.reasonOf(rows[0]!.grading.details)).toBe("runner_unavailable");
      // A proposal never counts towards a grade, so nothing is "done" yet.
      const progress = await service.progressOf(db, fixture.evaluationId);
      expect(progress).toMatchObject({ done: 0, total: 1, pending: { runner: 1, llm: 0 } });
    } finally {
      restore();
    }
  });

  it("validates the points a real runner produces", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const outcome: RunnerOutcome = {
        compile: { ok: true, stdout: "", stderr: "", ms: 1 },
        cases: [
          {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            ms: 2,
            timedOut: false,
            oom: false,
            truncated: false,
          },
        ],
      };
      const fakeRunner: RunnerService = {
        run: async () => outcome,
        health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
      };
      (app as unknown as { runner: RunnerService }).runner = fakeRunner;

      const fixture = await seedCodeEvaluation(db, app.clock.now());
      await runEvaluationGrading(app, { evaluationId: fixture.evaluationId });

      const rows = await gradingsOf(fixture.evaluationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.grading.state).toBe("validated");
      expect(rows[0]!.grading.points).toBeGreaterThan(0);
      expect(rows[0]!.grading.details).toMatchObject({ passed: 1 });
    } finally {
      restore();
    }
  });
});
