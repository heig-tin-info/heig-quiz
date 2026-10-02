/**
 * Grading at hand-in (ADR-067) against the real migrations: an exercise's
 * attempt is graded as soon as it is finished, whatever its feedback policy
 * and without retakes; an exam waits for its close; a reopen stands the
 * attempt's automatic gradings down (a teacher's stay), and the next hand-in
 * grades it again; a runner job overtaken by a reopen writes nothing.
 *
 * The queue is a recorder wired through the real `registerGradingJobs`: a
 * test sees which jobs were sent and drains them itself, in order.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultFeedbackPolicy, type EvaluationMode, type FeedbackPolicy, type McqPolicy } from "@quiz/contracts";
import type { RunnerOutcome, RunnerService } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluations, gradings, questions } from "../../db/schema.js";
import { GRADING_EVALUATION_QUEUE, GRADING_RUNNER_QUEUE, type JobQueue } from "../../jobs.js";
import { codeConfig } from "../../test/codeFixture.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { addItems, applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import { registerGradingJobs } from "../grading/jobs.js";
import { manualOverride } from "../grading/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import * as live from "./service.js";

let db: Db;
const restores: (() => void)[] = [];

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeRunnableCode));
  db = await testDb();
});
afterAll(() => {
  for (const restore of restores) restore();
});

const passing: RunnerOutcome = {
  compile: { ok: true, stdout: "", stderr: "", ms: 1 },
  cases: [
    { exitCode: 0, stdout: "ok", stderr: "", ms: 2, timedOut: false, oom: false, truncated: false },
  ],
};

/** A runner that always passes, and counts its calls. */
function countingRunner(): RunnerService & { calls: number } {
  const runner: RunnerService & { calls: number } = {
    calls: 0,
    run: async () => {
      runner.calls += 1;
      return passing;
    },
    health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
  };
  return runner;
}

/**
 * An app whose queue records what is sent and keeps the handlers the real
 * `registerGradingJobs` registers, so a test drains a queue when it chooses.
 */
async function queuedApp(runner: RunnerService = countingRunner()) {
  const base = await testApp(db);
  base.clock.set("2026-10-02T09:00:00.000Z");
  const sent: { name: string; data: unknown }[] = [];
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const queue: JobQueue = {
    createQueue: async () => {},
    send: async (name, data) => void sent.push({ name, data }),
    work: async (name, handler) => void handlers.set(name, handler as (data: unknown) => Promise<void>),
    stop: async () => {},
  };
  const app = Object.assign(Object.create(base), { boss: queue, runner }) as typeof base;
  await registerGradingJobs(app, queue);
  /** Runs every job sent to `name`, oldest first, the ones they send included. */
  const drain = async (name: string) => {
    const next = () => sent.findIndex((j) => j.name === name);
    for (let i = next(); i !== -1; i = next()) {
      const [job] = sent.splice(i, 1);
      await handlers.get(name)!(job!.data);
    }
  };
  return { app, sent, drain };
}

/** Two keys, two distractors; the student ticks both keys for full marks. */
const mcqConfig = (policy: McqPolicy) => ({
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

async function publish(poolId: string, ownerId: string, type: string, config: unknown) {
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type,
    internalName: type,
    createdBy: ownerId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config });
  await poolService.publishQuestion(db, question!, { userId: ownerId });
  return id;
}

/** A running evaluation of one mcq and one runner-graded code question, no retakes. */
async function running(
  app: Awaited<ReturnType<typeof testApp>>,
  mode: EvaluationMode,
  when: FeedbackPolicy["when"],
) {
  const seed = await seedLive(db, {
    mode,
    students: 1,
    questions: 0,
    durationS: null,
    settings: { timing: "manual", lobby: "skip" },
  });
  const mcq = await publish(seed.poolId, seed.teacherId, "mcq", mcqConfig("all_or_nothing"));
  const code = await publish(seed.poolId, seed.teacherId, "code", codeConfig);
  await db
    .update(evaluations)
    .set({ feedbackPolicy: { ...defaultFeedbackPolicy(), when } })
    .where(eq(evaluations.id, seed.evaluationId));
  const pointsOf = (type: string, version: Parameters<typeof loadConfig>[1]) =>
    typeOf(type).defaultPoints(loadConfig(type, version));
  await addItems(db, await reload(db, seed.evaluationId), [mcq, code], pointsOf, { attemptCount: 0 });
  const draft = await reload(db, seed.evaluationId);
  const evaluation = await applyState(db, draft, "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  const itemOf = (type: string) => items.find((i) => i.question.type === type)!.item;
  const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
  const entered = await live.enterEvaluation(db, { evaluation, participant, now: app.clock.now() });
  return { seed, evaluation, attempt: entered.attempt, mcq: itemOf("mcq"), code: itemOf("code") };
}

async function answer(
  evaluation: EvaluationRecord,
  attempt: live.AttemptRecord,
  itemId: string,
  payload: unknown,
  revision: number,
  now: Date,
) {
  await live.saveAnswer(db, { evaluation, attempt, itemId, payload, revision, now });
}

const standing = (attemptId: string) =>
  db
    .select()
    .from(gradings)
    .where(eq(gradings.attemptId, attemptId))
    .then((rows) => rows.filter((r) => r.state !== "superseded"));

describe("an exercise is graded at hand-in (ADR-067)", () => {
  it.each(["immediate", "on_release"] as const)(
    "without retakes, feedback %s: the mcq validated, the code sent to the runner",
    async (when) => {
      const { app, sent, drain } = await queuedApp();
      const { evaluation, attempt, mcq, code } = await running(app, "exercise", when);
      const now = app.clock.now();
      await answer(evaluation, attempt, mcq.id, { selected: [0, 1] }, 1, now);
      await answer(evaluation, attempt, code.id, { regions: ["return 0;"] }, 1, now);

      await live.submitAttempt(db, evaluation, attempt, now, app);
      expect(sent.map((j) => j.name)).toEqual([GRADING_EVALUATION_QUEUE]);
      await drain(GRADING_EVALUATION_QUEUE);

      const rows = await standing(attempt.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        itemId: mcq.id,
        state: "validated",
        source: "auto",
        points: mcq.points,
      });
      expect(sent).toEqual([
        {
          name: GRADING_RUNNER_QUEUE,
          data: expect.objectContaining({ attemptId: attempt.id, itemId: code.id, revision: 1 }),
        },
      ]);
    },
  );

  it("grades an attempt the teacher closes, too", async () => {
    const { app, sent } = await queuedApp();
    const { evaluation, attempt } = await running(app, "exercise", "on_release");
    await live.closeAttempt(db, evaluation, attempt, app.clock.now(), app);
    expect(sent).toEqual([
      {
        name: GRADING_EVALUATION_QUEUE,
        data: { evaluationId: evaluation.id, attemptIds: [attempt.id] },
      },
    ]);
  });

  it("leaves an exam to its close", async () => {
    const app = await testApp(db);
    app.clock.set("2026-10-02T09:00:00.000Z");
    const { evaluation, attempt, mcq, code } = await running(app, "exam", "on_release");
    const now = app.clock.now();
    await answer(evaluation, attempt, mcq.id, { selected: [0, 1] }, 1, now);
    await answer(evaluation, attempt, code.id, { regions: ["return 0;"] }, 1, now);

    await live.submitAttempt(db, evaluation, attempt, now, app);
    expect(await standing(attempt.id)).toEqual([]);

    await live.closeEvaluation(db, await reload(db, evaluation.id), now, "teacher", app);
    const rows = await standing(attempt.id);
    expect(rows.find((r) => r.itemId === mcq.id)).toMatchObject({ state: "validated", points: mcq.points });
    // The test app's runner is the stub: the code cell ends as a proposal.
    expect(rows.find((r) => r.itemId === code.id)).toMatchObject({ state: "proposed" });
  });
});

describe("a reopen of an exercise attempt graded at hand-in", () => {
  it("stands the automatic gradings down, keeps the teacher's, and the next hand-in grades again", async () => {
    const { app, drain } = await queuedApp();
    const { seed, evaluation, attempt, mcq, code } = await running(app, "exercise", "immediate");
    let now = app.clock.now();
    await answer(evaluation, attempt, mcq.id, { selected: [0, 1] }, 1, now);
    await answer(evaluation, attempt, code.id, { regions: ["return 0;"] }, 1, now);
    await live.submitAttempt(db, evaluation, attempt, now, app);
    await drain(GRADING_EVALUATION_QUEUE);
    await drain(GRADING_RUNNER_QUEUE);
    expect(await standing(attempt.id)).toHaveLength(2);

    // The teacher settles the code cell by hand.
    app.clock.advance(1000);
    const override = await manualOverride(
      db,
      { attemptId: attempt.id, itemId: code.id, answerId: null, maxPoints: code.points },
      { points: 0.5, comment: "partial credit" },
      seed.teacherId,
      app.clock.now(),
    );

    app.clock.advance(1000);
    now = app.clock.now();
    const finished = (await live.attemptById(db, attempt.id))!;
    const reopened = await live.reopenAttempt(db, evaluation, finished, now);
    const afterReopen = await standing(attempt.id);
    expect(afterReopen.map((r) => r.id)).toEqual([override.id]);
    // Nothing deleted: the stood-down grading is still in the history.
    const all = await db.select().from(gradings).where(eq(gradings.attemptId, attempt.id));
    expect(all.filter((r) => r.itemId === mcq.id).map((r) => r.state)).toEqual(["superseded"]);

    // The student rewrites the mcq wrong and hands in again.
    await answer(evaluation, reopened, mcq.id, { selected: [2] }, 2, now);
    await live.submitAttempt(db, evaluation, reopened, now, app);
    await drain(GRADING_EVALUATION_QUEUE);
    await drain(GRADING_RUNNER_QUEUE);

    const after = await standing(attempt.id);
    expect(after.find((r) => r.itemId === mcq.id)).toMatchObject({
      state: "validated",
      source: "auto",
      points: 0,
    });
    expect(after.find((r) => r.itemId === code.id)!.id).toBe(override.id);
  });

  it("makes a runner job sent before it write nothing, and the next hand-in's job grade", async () => {
    const runner = countingRunner();
    const { app, sent, drain } = await queuedApp(runner);
    const { evaluation, attempt, code } = await running(app, "exercise", "on_release");
    let now = app.clock.now();
    await answer(evaluation, attempt, code.id, { regions: ["return 1;"] }, 1, now);
    await live.submitAttempt(db, evaluation, attempt, now, app);
    await drain(GRADING_EVALUATION_QUEUE);
    expect(sent.filter((j) => j.name === GRADING_RUNNER_QUEUE)).toHaveLength(1);

    // Reopened while its runner job waits: the job, run now, is stale.
    app.clock.advance(1000);
    now = app.clock.now();
    const reopened = await live.reopenAttempt(db, evaluation, (await live.attemptById(db, attempt.id))!, now);
    await drain(GRADING_RUNNER_QUEUE);
    expect(runner.calls).toBe(0);
    expect((await standing(attempt.id)).filter((r) => r.itemId === code.id)).toEqual([]);

    // Rewritten and handed in again: the first hand-in's job, had it waited
    // this long, would still be stale (another revision); the new one grades.
    await answer(evaluation, reopened, code.id, { regions: ["return 0;"] }, 2, now);
    await live.submitAttempt(db, evaluation, reopened, now, app);
    await drain(GRADING_EVALUATION_QUEUE);
    const jobs = sent.filter((j) => j.name === GRADING_RUNNER_QUEUE);
    expect(jobs.map((j) => (j.data as { revision: number }).revision)).toEqual([2]);
    sent.unshift({ name: GRADING_RUNNER_QUEUE, data: { ...(jobs[0]!.data as object), revision: 1 } });
    await drain(GRADING_RUNNER_QUEUE);
    expect(runner.calls).toBe(1);
    const rows = (await standing(attempt.id)).filter((r) => r.itemId === code.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "validated", points: code.points });
  });
});

describe("the grading.runner queue", () => {
  /** The options each queue's worker was registered with. */
  async function workOptions(config?: { GRADING_RUNNER_CONCURRENCY: number }) {
    const options = new Map<string, unknown>();
    const queue: JobQueue = {
      createQueue: async () => {},
      send: async () => {},
      work: async (name, _handler, opts) => void options.set(name, opts),
      stop: async () => {},
    };
    await registerGradingJobs(await testApp(db), queue, config);
    return options;
  }

  it("takes one job at a time by default, so grading never fills the runner's queue", async () => {
    expect((await workOptions()).get(GRADING_RUNNER_QUEUE)).toEqual({ localConcurrency: 1 });
  });

  it("takes GRADING_RUNNER_CONCURRENCY at a time when configured", async () => {
    expect((await workOptions({ GRADING_RUNNER_CONCURRENCY: 3 })).get(GRADING_RUNNER_QUEUE)).toEqual({
      localConcurrency: 3,
    });
  });
});
