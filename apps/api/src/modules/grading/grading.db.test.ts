/**
 * The grading job and the panel against the real migrations (PLAN-MVP §8,
 * WP6).
 *
 * The job is exercised by calling its handler directly: no queue, no timer,
 * no sleep. Everything it depends on — the clock, the runner — is an object
 * the test hands over, which is what makes "the stub degrades to a proposal"
 * and "a real runner validates" two lines apart.
 *
 * Also here: the MCQ scoring hierarchy end to end (docs/04 §4.4) — the
 * teacher's preference seeds the evaluation, the evaluation is what an
 * `inherit` question defers to, and a question that names a policy
 * overrides both; the same hierarchy, minus the preference, for
 * `categorize` (ADR-036, `settings.categorizePolicy`). The two halves a unit
 * test cannot prove: that the column carries the preference at creation, and
 * that the pass hands the evaluation's policy to the type's `grade`.
 *
 * And the batched writer of the pass (D-01): what one pass costs in
 * statements, and the supersede chain `writeGradings` builds for many cells
 * at once.
 */
import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { reasonOf, type McqPolicy } from "@quiz/contracts";
import type { RunnerOutcome, RunnerService } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, attempts, evaluations, gradings, guestParticipants, questions, users } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { pgliteDb, testApp, testDatabase } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { reload, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, byId, createEvaluation, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { runEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";
import { writeGradings } from "./service.js";

let client: PGlite;
let db: Db;
const restores: (() => void)[] = [];

beforeAll(async () => {
  restores.push(registerForTests(fakeShort));
  ({ db, client } = await testDatabase());
});
afterAll(() => {
  for (const restore of restores) restore();
});

/** An app whose db is the shared one; `boss` is null, so jobs run inline. */
async function appFor() {
  const app = await testApp(db);
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
    // One millisecond apart: the panel orders attempts by creation, and two
    // rows created on the same instant have no order of their own.
    app.clock.advance(1);
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

  it("ends in the pending phase when a cell went to the runner", async () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const app = await appFor();
      const fixture = await seedCodeEvaluation(db, app.clock.now());
      const frames = await progressDuring(fixture.evaluationId, () =>
        runEvaluationGrading(app, { evaluationId: fixture.evaluationId }),
      );
      expect(frames).toEqual(["1/1/pending"]);
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
      const result = await service.gradingQueue(db, record, { anonymous: true, ...query });
      return {
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

  it("walks the evaluation question by question, with the counts of the selection", async () => {
    const { items, queue } = await queueFixture();

    const all = await queue({});
    expect(all.items).toEqual(items.map((i) => i.item.id));
    expect(all.entries).toEqual([
      "s0q0:validated:answer:1",
      "s1q0:validated:answer:1",
      "s0q1:proposed:no-answer:1",
      "s1q1:none:no-answer:0",
    ]);
    expect(all.counts).toEqual({ total: 4, validated: 2, proposed: 1, missing: 1 });

    // An item narrows the selection, and the counts with it.
    const oneItem = await queue({ itemId: items[1]!.item.id });
    expect(oneItem.items).toEqual([items[1]!.item.id]);
    expect(oneItem.entries).toEqual(["s0q1:proposed:no-answer:1", "s1q1:none:no-answer:0"]);
    expect(oneItem.counts).toEqual({ total: 2, validated: 0, proposed: 1, missing: 1 });
    // Narrowed, the panel reads only the selected cells — and shows each one
    // exactly as the whole panel does: answer, views, grading, history.
    expect(oneItem.raw).toEqual(all.raw.filter((e) => e.itemId === items[1]!.item.id));
  });

  it("names a guest's attempt, which has no account behind it (ADR-014)", async () => {
    const { evaluation, attempts: rows } = await closedEvaluation();
    const guestId = randomUUID();
    await db
      .insert(guestParticipants)
      .values({ id: guestId, evaluationId: evaluation.id, tokenHash: randomUUID() });
    await db
      .update(attempts)
      .set({ userId: null, guestId })
      .where(eq(attempts.id, rows[0]!.id));
    const record = (await byId(db, evaluation.id))!;
    const named = await service.gradingQueue(db, record, { anonymous: false });
    // The guest is a number, worded by the web; the account keeps its name.
    const who = [...new Set(named.entries.map((e) => `${e.label}/${e.guest}`))];
    expect(who).toEqual(["null/1", "Test student/null"]);
    const anonymous = await service.gradingQueue(db, record, { anonymous: true });
    expect(anonymous.entries.every((e) => e.label === null && e.guest === null)).toBe(true);
  });

  it("summarises each question with the queue's own counts (#107)", async () => {
    const { evaluation, items, queue } = await queueFixture();
    const record = (await byId(db, evaluation.id))!;

    const steps = await service.gradingSteps(db, record);
    expect(steps.steps.map((s) => [s.key, s.total, s.validated])).toEqual([
      [items[0]!.item.id, 2, 2],
      [items[1]!.item.id, 2, 0],
    ]);
    // Each step counts what its queue counts.
    for (const step of steps.steps) {
      const counts = (await queue({ itemId: step.key })).counts;
      expect({ total: step.total, validated: step.validated }).toEqual({
        total: counts.total,
        validated: counts.validated,
      });
    }
  });

  it("labels, views and history of every entry", async () => {
    const { queue } = await queueFixture();
    const named = (await queue({ anonymous: false })).raw;
    const anonymous = (await queue({ anonymous: true })).raw;
    for (const [index, entry] of named.entries()) {
      expect(entry.label).toBe("Test student");
      expect(entry.staff).toBe(false);
      // One attempt each: no number, and it is the one that counts.
      expect(entry.attemptNumber).toBeNull();
      expect(entry.kept).toBe(true);
      expect(entry.student).not.toBeNull();
      expect(entry.solution).not.toBeNull();
      // A static question has no values (ADR-056 §9).
      expect(entry).not.toHaveProperty("values");
      // Anonymous is the same entry without its label — no pseudonym either
      // (ADR-044).
      expect(anonymous[index]).toEqual({ ...entry, label: null });
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
    // The cell route reads the same history, line for line.
    expect(await service.historyOfCell(db, right!.attemptId, right!.itemId)).toEqual(
      right!.history,
    );
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
      rows[0]!.userId!,
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
        rows[0]!.userId!,
        app.clock.now(),
      ),
    ).rejects.toMatchObject({ code: "comment_required" });
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
      rows[0]!.userId!,
      now,
    );
    expect(byItem).toBe(1);

    const byConfidence = await service.batchValidate(
      db,
      evaluation.id,
      { confidence: "high" },
      rows[0]!.userId!,
      now,
    );
    // The high-confidence one is already validated; nothing is left.
    expect(byConfidence).toBe(0);

    const rest = await service.batchValidate(db, evaluation.id, {}, rows[0]!.userId!, now);
    expect(rest).toBe(1);
  });

  it("leaves a 0-point placeholder without confidence to a person (#192)", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    const now = app.clock.now();
    const propose = (attemptId: string, points: number) =>
      service.writeGrading(db, {
        attemptId,
        itemId: items[0]!.item.id,
        answerId: null,
        points,
        maxPoints: 1,
        source: "auto",
        state: "proposed",
        details: { reason: "manual" },
        now,
      });
    // An essay nobody has read yet, and a proposal a grader did score.
    const placeholder = await propose(rows[0]!.id, 0);
    await propose(rows[1]!.id, 0.5);

    expect(await service.batchValidate(db, evaluation.id, {}, rows[0]!.userId!, now)).toBe(1);
    const [standing] = await db
      .select({ state: gradings.state })
      .from(gradings)
      .where(eq(gradings.id, placeholder.id));
    expect(standing!.state).toBe("proposed");
  });

  it("leaves the history a click by click validation would", async () => {
    const { app, evaluation, items, attempts: rows } = await closedEvaluation();
    const propose = (attemptId: string) =>
      service.writeGrading(db, {
        attemptId,
        itemId: items[1]!.item.id,
        answerId: null,
        points: 0.5,
        maxPoints: 1,
        source: "auto",
        state: "proposed",
        confidence: "medium",
        comment: "machine",
        regradeNote: "note",
        details: { reason: "llm" },
        now: app.clock.now(),
      });
    const [clicked, batched] = [await propose(rows[0]!.id), await propose(rows[1]!.id)];
    app.clock.advance(1000);
    const teacher = rows[0]!.userId!;
    await service.validateGrading(db, clicked, {}, teacher, app.clock.now());
    expect(
      await service.batchValidate(db, evaluation.id, { itemId: items[1]!.item.id }, teacher, app.clock.now()),
    ).toBe(1);

    // The same cell history, field for field, but for the ids and the attempt.
    const shape = async (proposal: typeof clicked) => {
      const history = await db
        .select()
        .from(gradings)
        .where(and(eq(gradings.attemptId, proposal.attemptId), eq(gradings.itemId, proposal.itemId)))
        .orderBy(gradings.createdAt);
      expect(history.map((g) => g.state)).toEqual(["superseded", "validated"]);
      expect(history[1]!.supersedesId).toBe(proposal.id);
      return history.map(({ id, attemptId, supersedesId, ...rest }) => rest);
    };
    expect(await shape(batched)).toEqual(await shape(clicked));
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
      expect(reasonOf(rows[0]!.grading.details)).toBe("runner_unavailable");
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

// --- The MCQ and categorize policy hierarchy (docs/04 §4.4, ADR-036) ------

/** Two keys, two distractors: C = 2, W = 2, so every policy gives its own mark. */
const mcqConfig = (policy: "inherit" | McqPolicy) => ({
  configVersion: 2,
  prompt: "Which declarations are valid in C17?",
  choices: [
    { text: "`int a[] = {1,2,3};`", correct: true },
    { text: "`int a[3] = {0};`", correct: true },
    { text: "`int a[];`", correct: false },
    { text: "`int a[-1];`", correct: false },
  ],
  mode: "multiple",
  policy,
  shuffleChoices: false,
});

async function publishMcq(
  poolId: string,
  ownerId: string,
  name: string,
  policy: "inherit" | McqPolicy,
): Promise<string> {
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type: "mcq",
    internalName: name,
    createdBy: ownerId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config: mcqConfig(policy) });
  await poolService.publishQuestion(db, question!, { userId: ownerId });
  return id;
}

describe("the evaluation is seeded from its creator's preference", () => {
  it("copies the preference at creation, and falls back to all or nothing", async () => {
    const seed = await seedLive(db, { questions: 0 });

    const plain = await createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "No preference",
      mode: "exam",
      createdBy: seed.teacherId,
    });
    expect(plain.mcqPolicy).toBe("all_or_nothing");

    await db
      .update(users)
      .set({ mcqPolicy: "discordance" })
      .where(eq(users.id, seed.teacherId));
    const seeded = await createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "With a preference",
      mode: "exam",
      createdBy: seed.teacherId,
    });
    expect(seeded.mcqPolicy).toBe("discordance");

    // The preference is a SEED: moving it never moves an evaluation that
    // already exists.
    await db.update(users).set({ mcqPolicy: "ripkey" }).where(eq(users.id, seed.teacherId));
    expect((await byId(db, seeded.id))!.mcqPolicy).toBe("discordance");
  });
});

describe("the grading pass applies the hierarchy", () => {
  /**
   * One evaluation scored `true_false`, two mcq items — one inheriting, one
   * overriding with `ripkey` — and a student who ticks exactly one of the two
   * correct choices. The marks then differ by policy and by nothing else:
   * `true_false` gives (1 + 2) / 4 = 0.75, `ripkey` gives 1/2 = 0.5.
   */
  it("uses the evaluation's policy for inherit and the question's otherwise", async () => {
    const app = await testApp(db);
    app.clock.set("2026-09-20T09:00:00.000Z");
    const seed = await seedLive(db, { students: 1, questions: 0 });

    const inheriting = await publishMcq(seed.poolId, seed.teacherId, "mcq-inherit", "inherit");
    const overriding = await publishMcq(seed.poolId, seed.teacherId, "mcq-ripkey", "ripkey");

    await db
      .update(evaluations)
      .set({ mcqPolicy: "true_false" })
      .where(eq(evaluations.id, seed.evaluationId));
    let evaluation = (await byId(db, seed.evaluationId))!;
    await evaluationService.addItems(
      db,
      evaluation,
      [inheriting, overriding],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, version),
        ),
      { attemptCount: 0 },
    );

    evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const items = await joinedItems(db, evaluation.id);
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, item] of items.entries()) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        // One of the two keys, and no distractor.
        payload: { selected: [0] },
        revision: index + 1,
        now: app.clock.now(),
      });
    }
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(2);

    const detailsOf = (itemId: string) =>
      rows.find((r) => r.grading.itemId === itemId)!.grading.details as {
        policy: string;
        fraction: number;
      };
    const byQuestion = new Map(items.map((i) => [i.question.id, i.item.id]));

    const inherited = detailsOf(byQuestion.get(inheriting)!);
    expect(inherited.policy).toBe("true_false");
    expect(inherited.fraction).toBeCloseTo(0.75, 10);

    const overridden = detailsOf(byQuestion.get(overriding)!);
    expect(overridden.policy).toBe("ripkey");
    expect(overridden.fraction).toBeCloseTo(0.5, 10);
  });
});

/** Columns A and B, one target each, and a distractor: T = 2, D = 1. */
const categorizeConfig = (policy: "inherit" | "per_item" | "all_or_nothing") => ({
  configVersion: 1,
  prompt: "Sort the cards.",
  columns: [
    { id: "col4a9xq", label: "A", cards: ["crd7k2ma"] },
    { id: "col8m3wz", label: "B", cards: ["crd1p6vb"] },
  ],
  cards: [
    { id: "crd7k2ma", text: "a" },
    { id: "crd1p6vb", text: "b" },
    { id: "crd5d0zt", text: "distractor" },
  ],
  shuffleCards: false,
  policy,
});

describe("the grading pass hands categorize the evaluation's policy (ADR-036)", () => {
  /**
   * The evaluation says `all_or_nothing`; one item inherits it, one names
   * `per_item`. The student places one target right, leaves the other and the
   * distractor in the tray: all or nothing gives 0, per card (1 + 1) / 3.
   */
  it("uses settings.categorizePolicy for inherit and the question's otherwise", async () => {
    const app = await testApp(db);
    app.clock.set("2026-09-20T09:00:00.000Z");
    const seed = await seedLive(db, { students: 1, questions: 0 });

    const publish = async (name: string, policy: "inherit" | "per_item") => {
      const { id } = await poolService.createQuestion(db, {
        poolId: seed.poolId,
        type: "categorize",
        internalName: name,
        createdBy: seed.teacherId,
      });
      const [question] = await db.select().from(questions).where(eq(questions.id, id));
      await poolService.putDraft(db, question!, { config: categorizeConfig(policy) });
      await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
      return id;
    };
    const inheriting = await publish("categorize-inherit", "inherit");
    const overriding = await publish("categorize-per-item", "per_item");

    let evaluation = (await byId(db, seed.evaluationId))!;
    await db
      .update(evaluations)
      .set({ settings: { ...evaluationService.settingsOf(evaluation), categorizePolicy: "all_or_nothing" } })
      .where(eq(evaluations.id, seed.evaluationId));
    evaluation = (await byId(db, seed.evaluationId))!;
    await evaluationService.addItems(
      db,
      evaluation,
      [inheriting, overriding],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, version),
        ),
      { attemptCount: 0 },
    );

    evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const items = await joinedItems(db, evaluation.id);
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, item] of items.entries()) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        payload: { columns: { col4a9xq: ["crd7k2ma"] } },
        revision: index + 1,
        now: app.clock.now(),
      });
    }
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(2);

    const detailsOf = (itemId: string) =>
      rows.find((r) => r.grading.itemId === itemId)!.grading.details as { policy: string; fraction: number };
    const byQuestion = new Map(items.map((i) => [i.question.id, i.item.id]));

    const inherited = detailsOf(byQuestion.get(inheriting)!);
    expect(inherited.policy).toBe("all_or_nothing");
    expect(inherited.fraction).toBe(0);

    const overridden = detailsOf(byQuestion.get(overriding)!);
    expect(overridden.policy).toBe("per_item");
    expect(overridden.fraction).toBeCloseTo(2 / 3, 10);
  });
});

// --- The batched writer of the pass (D-01) ------------------------------

const NOW = new Date("2026-09-20T09:00:00.000Z");

/** A closed evaluation of `students` × `questions` cells; every student answered the first. */
async function closedGrid(students: number, questions: number) {
  const seed = await seedLive(db, { students, questions });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", NOW);
  const items = await joinedItems(db, evaluation.id);
  const attemptIds: string[] = [];
  for (const [index, userId] of seed.studentIds.entries()) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, NOW);
    const attempt = await live.beginAttempt(db, evaluation, created, participant, NOW);
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[0]!.item.id,
      payload: index % 2 === 0 ? "answer-q0" : "nope",
      revision: 1,
      now: NOW,
    });
    attemptIds.push(attempt.id);
  }
  evaluation = await live.closeEvaluation(db, evaluation, NOW);
  return { evaluation, items, attemptIds };
}

describe("the grading pass writes in batches (D-01)", () => {
  it("grades 10 × 5 cells in one transaction of two write statements", async () => {
    const { evaluation } = await closedGrid(10, 5);

    // The same database, seen through a drizzle handle that logs every
    // statement, and the driver's transactions counted underneath.
    const statements: string[] = [];
    const logged = pgliteDb(client, { logQuery: (query) => statements.push(query) });
    const app = await testApp(logged);
    app.clock.set(NOW.toISOString());

    const transactions = vi.spyOn(client, "transaction");
    let transactionCount: number;
    try {
      await runEvaluationGrading(app, { evaluationId: evaluation.id });
      transactionCount = transactions.mock.calls.length;
    } finally {
      transactions.mockRestore();
    }

    // Before D-01: 50 transactions, 50 UPDATE + 50 INSERT.
    const writes = statements.filter((s) => /^(update|insert into) "gradings"/i.test(s));
    expect(writes.map((s) => s.split(" ")[0]!.toLowerCase())).toEqual(["update", "insert"]);
    expect(transactionCount).toBe(1);

    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.grading.state === "validated")).toBe(true);
  });
});

describe("writeGradings", () => {
  it("supersedes what stands on each cell and chains to it, never a validated one from a proposal", async () => {
    const { items, attemptIds } = await closedGrid(3, 1);
    const itemId = items[0]!.item.id;
    const cell = (attemptId: string) => ({
      attemptId,
      itemId,
      answerId: null,
      maxPoints: 1,
      source: "auto" as const,
      now: NOW,
    });
    const [a, b, c] = attemptIds as [string, string, string];

    const first = await writeGradings(db, [
      { ...cell(a), points: 0, state: "proposed" },
      { ...cell(b), points: 1, state: "validated" },
    ]);
    expect(first.map((r) => r.supersedesId)).toEqual([null, null]);

    const second = await writeGradings(db, [
      // Validated over a proposal: supersedes it.
      { ...cell(a), points: 1, state: "validated" },
      // A proposal over a validated grade: supersedes nothing.
      { ...cell(b), points: 0, state: "proposed" },
      // A fresh cell.
      { ...cell(c), points: 0, state: "validated" },
    ]);
    expect(second.map((r) => r.attemptId)).toEqual([a, b, c]);
    expect(second.map((r) => r.supersedesId)).toEqual([first[0]!.id, null, null]);

    const stateOf = async (id: string) =>
      (await db.select().from(gradings).where(eq(gradings.id, id)))[0]!.state;
    expect(await stateOf(first[0]!.id)).toBe("superseded");
    expect(await stateOf(first[1]!.id)).toBe("validated");

    const standingOnB = await db
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, b), eq(gradings.itemId, itemId)));
    expect(standingOnB.map((r) => r.state).sort()).toEqual(["proposed", "validated"]);
  });

  it("refuses a batch that names one cell twice, and writes nothing", async () => {
    const { items, attemptIds } = await closedGrid(1, 1);
    const cell = {
      attemptId: attemptIds[0]!,
      itemId: items[0]!.item.id,
      answerId: null,
      maxPoints: 1,
      points: 0,
      source: "auto" as const,
      state: "proposed" as const,
      now: NOW,
    };
    await expect(writeGradings(db, [cell, { ...cell, state: "validated" }])).rejects.toThrow(
      /appears twice in one batch/,
    );
    const rows = await db.select().from(gradings).where(eq(gradings.attemptId, cell.attemptId));
    expect(rows).toHaveLength(0);
  });

  it("writes nothing for an empty batch", async () => {
    expect(await writeGradings(db, [])).toEqual([]);
  });
});
