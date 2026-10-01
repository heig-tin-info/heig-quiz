/**
 * The grading jobs (PLAN-MVP §5.4, docs/05 §5.6).
 *
 * ```
 * POST /close  or  ticker auto-close
 *       └─▶ grading.evaluation { evaluationId }   (one job per request, #273)
 *
 * grading.evaluation, for each (attempt × item):
 *    a validated grading already stands           → skip          (idempotent)
 *    no answer row at all                         → 0, validated, auto  (F-GRADE-01)
 *    type.grade() returns 'graded'                → validated (or proposed if it says so)
 *    type.grade() returns pending: 'runner'       → grading.runner, low priority
 *    type.grade() returns pending: 'llm'          → app.llm.grade() → proposed, source 'llm',
 *                                                   with the model's confidence
 *                                                   (no provider: reason 'llm_not_configured')
 *    then, the grid complete                      → grading_ready, once (`ready.ts`)
 *
 * grading.runner, for one answer:
 *    runner.run() → type.finalizeRunner()         → validated
 *    RunnerUnavailable (the stub, decision D14)   → proposed, reason 'runner_unavailable'
 *    RunnerBusy                                   → rethrown, pg-boss retries
 *    anything else                                → proposed, reason 'runner_error'
 *    then, the grid complete                      → grading_ready, once (`ready.ts`)
 * ```
 *
 * Nothing here ever blocks: a machine with no container engine still closes,
 * grades, releases and exports an evaluation containing `code` questions —
 * the code answers simply arrive in the panel as proposals a teacher settles.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";

import type {
  GradeContext,
  GradeResult,
  LlmGradeOutcome,
  PendingLlmResult,
  RunnerRequest,
} from "@quiz/core/server";
import { INSTANCE_WARNING_KEY, JUSTIFICATION_KEY, type PassReason } from "@quiz/contracts";
import { RunnerBusy, RunnerUnavailable, isGraded, isPendingRunner } from "@quiz/core/server";
import { isLiveState, itemPoints, round2 } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { answers, attempts, gradings } from "../../db/schema.js";
import {
  GRADING_EVALUATION_QUEUE,
  GRADING_RUNNER_QUEUE,
  type JobQueue,
} from "../../jobs.js";
import {
  byId,
  gradeDefaults,
  joinedItem,
  joinedItems,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { hasKey, loadConfig, typeOf } from "../pool/config.js";
import { exampleConfig, isParameterized, itemInstance } from "../pool/service.js";
import type { StoredInstance } from "../../db/columns.js";
import * as events from "./events.js";
import { announceGradingReady } from "./ready.js";
import {
  pairKey,
  standingGradings,
  writeGrading,
  writeGradings,
  type GradingRecord,
  type PairKey,
  type WriteGradingInput,
} from "./service.js";

/** How often the progress event goes out while a pass is running (§5.4). */
const PROGRESS_EVERY = 25;

/** Low priority: a container run must never delay the deterministic half. */
const RUNNER_PRIORITY = -10;

/**
 * Every machine reason a pass leaves on a grading it could not settle. They
 * are wire values, closed once in `@quiz/contracts` (`PASS_REASONS`): the
 * web translates each of them, and `progressOf` counts them.
 */
type ProposalReason = PassReason;

/**
 * A proposal worth zero that says why no grader settled the cell — never a
 * crash and never a silent zero: a teacher decides (§5.4). The reason goes in
 * `details` (what `reasonOf` reads) and in `comment` (what the panel shows).
 */
const failedProposal = (reason: ProposalReason, source: "auto" | "llm" = "auto") => ({
  points: 0,
  source,
  state: "proposed" as const,
  details: { reason },
  comment: reason,
});

interface EvaluationGradingJob {
  evaluationId: string;
  /** Restricts the pass to these items; omitted = the whole evaluation. */
  itemIds?: string[];
  /**
   * Restricts the pass to these attempts; omitted = every attempt. One
   * attempt closed by the teacher after the evaluation's own close (#95).
   */
  attemptIds?: string[];
  /** Stamped on every grading this pass writes (F-GRADE-06). */
  regradeNote?: string;
}

interface RunnerGradingJob {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  answerId: string | null;
  request: RunnerRequest;
  regradeNote?: string;
}

/**
 * Enqueues the pass, or runs it inline when this process has no queue.
 *
 * A missing queue is a real configuration (`JOBS_DISABLED=1`, and every route
 * test), not a failure: the honest behaviour there is to do the work rather
 * than to drop it silently. The queue is what makes it durable, not what
 * makes it happen.
 *
 * Every request is its own job, never deduplicated (#273). The payloads are
 * not interchangeable — a retake's pass covers one attempt, a re-grade one
 * item with its note, the close's the whole evaluation — so
 * collapsing two of them loses the scope of one; that is how a pending retake
 * pass used to swallow the close's pass and leave attempts ungraded. Nothing
 * needs the dedupe either:
 *
 *   - a pass is idempotent: a validated cell is skipped, a proposal is
 *     superseded by an identical new row (only its `gradedAt` differs), and
 *     `grading_ready` goes out once per complete grid (`ready.ts`);
 *   - passes do not overlap: pg-boss takes the jobs of a queue one at a time
 *     per process (`localConcurrency` 1), in order of creation, and so does
 *     the in-process queue — so a retake pass sent while the evaluation ran
 *     always runs before the close's pass;
 *   - were two processes ever to work the queue (`WORKER_MODE` split), two
 *     passes racing on one cell end in one of two ways. The loser's write
 *     starts after the winner's commit: it silently supersedes the winner's
 *     grading with its own, identical, automatic one. Or the two overlap:
 *     they collide on `gradings_pair_validated_uq`, the loser throws, and
 *     its retry (`retryLimit: 1`) skips what the winner validated.
 *
 * The cost is a redundant pass when a button is pressed twice: bounded, and
 * cheap next to losing one.
 */
export async function enqueueEvaluationGrading(
  app: FastifyInstance,
  job: EvaluationGradingJob,
): Promise<boolean> {
  const queue = app.boss;
  if (!queue) {
    await runEvaluationGrading(app, job);
    return false;
  }
  await queue.send(GRADING_EVALUATION_QUEUE, job);
  return true;
}

/** Registers the two handlers. Called once, from `buildApp`. */
export async function registerGradingJobs(app: FastifyInstance, queue: JobQueue): Promise<void> {
  await queue.createQueue(GRADING_EVALUATION_QUEUE, { retryLimit: 1 });
  await queue.createQueue(GRADING_RUNNER_QUEUE, {
    retryLimit: 2,
    retryBackoff: true,
    retryDelay: 5,
  });
  await queue.work<EvaluationGradingJob>(GRADING_EVALUATION_QUEUE, (data) =>
    runEvaluationGrading(app, data),
  );
  await queue.work<RunnerGradingJob>(GRADING_RUNNER_QUEUE, (data) => runRunnerGrading(app, data));
}

// --- The evaluation pass --------------------------------------------------

type AttemptRecord = typeof attempts.$inferSelect;

/** What one pass reads up front: the grid, and what already stands on it. */
interface Pass {
  items: JoinedItem[];
  attempts: AttemptRecord[];
  answers: Map<PairKey, typeof answers.$inferSelect>;
  standing: Map<PairKey, GradingRecord>;
  teacherIds: string[];
}

/** The reads of a pass, or `null` when the grid is empty and there is nothing to do. */
async function loadPass(
  db: Db,
  evaluation: EvaluationRecord,
  job: EvaluationGradingJob,
): Promise<Pass | null> {
  const allItems = await joinedItems(db, evaluation.id);
  const items = job.itemIds ? allItems.filter((i) => job.itemIds!.includes(i.item.id)) : allItems;
  const attemptRows = await db
    .select()
    .from(attempts)
    .where(
      job.attemptIds
        ? and(eq(attempts.evaluationId, evaluation.id), inArray(attempts.id, job.attemptIds))
        : eq(attempts.evaluationId, evaluation.id),
    );
  if (items.length === 0 || attemptRows.length === 0) return null;

  const answerRows = await db
    .select()
    .from(answers)
    .where(
      inArray(
        answers.attemptId,
        attemptRows.map((a) => a.id),
      ),
    );
  return {
    items,
    attempts: attemptRows,
    answers: new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a])),
    standing: await standingGradings(db, evaluation.id),
    teacherIds: await events.staffOf(db, evaluation),
  };
}

/**
 * The progress events of a pass (§5.4): one every {@link PROGRESS_EVERY}
 * cells walked, skipped or graded alike, and a final one, once the batch is
 * written, that says what is left.
 */
function progressReporter(evaluation: EvaluationRecord, teacherIds: string[], total: number) {
  let done = 0;
  let sinceEvent = 0;
  return {
    /** One cell walked. */
    tick(): void {
      done += 1;
      sinceEvent += 1;
      if (sinceEvent < PROGRESS_EVERY) return;
      sinceEvent = 0;
      events.progress(evaluation, teacherIds, { done, total, phase: "auto" });
    },
    finish(phase: "runner" | "done"): void {
      events.progress(evaluation, teacherIds, { done, total, phase });
    },
  };
}

/** One item's config for one attempt, and the warning of its instance (ADR-056 §7). */
interface CellConfig {
  config: unknown;
  warning?: StoredInstance["fallback"];
}

/**
 * The stored config of one item through `loadConfig`, the ONE read pipeline
 * (§1.6): migrated and parsed once per item, not once per attempt — but for
 * a parameterized question, whose every attempt has its own instance, read
 * from the values the attempt stored (ADR-056 §5; replayed under a version
 * a regrade retargeted). `null` when it cannot be read, and the cell
 * becomes a proposal.
 */
function readConfig(app: FastifyInstance, item: JoinedItem): (attempt: AttemptRecord) => CellConfig | null {
  const unreadable = (err: unknown) => {
    app.log.error({ err, itemId: item.item.id }, "grading: unreadable question config");
    return null;
  };
  if (!isParameterized(item.version)) {
    let cell: CellConfig | null;
    try {
      cell = { config: loadConfig(item.question.type, item.version) };
    } catch (err) {
      cell = unreadable(err);
    }
    return () => cell;
  }
  return (attempt) => {
    try {
      const instance = itemInstance(item, attempt);
      const config = loadConfig(item.question.type, instance.version);
      return instance.fallback ? { config, warning: instance.fallback } : { config };
    } catch (err) {
      return unreadable(err);
    }
  };
}

/** Whether an item holds a key: on its example instance when parameterized (structure only). */
function itemHasKey(item: JoinedItem): boolean {
  const type = item.question.type;
  try {
    return hasKey(type, exampleConfig(type, item.version));
  } catch {
    // Unreadable: every cell says so on its own (`config_unreadable`).
    return true;
  }
}

/**
 * One cell that no teacher has settled yet: the grading to write, or the
 * runner job it needs. The pass writes the gradings in one batch, and
 * enqueues the runner jobs only once that batch is written.
 */
async function gradeCell(
  app: FastifyInstance,
  cell: {
    evaluation: EvaluationRecord;
    job: EvaluationGradingJob;
    item: JoinedItem;
    config: CellConfig | null;
    attempt: AttemptRecord;
    answer: typeof answers.$inferSelect | null;
  },
): Promise<{ write: WriteGradingInput } | { runner: RunnerGradingJob }> {
  const { evaluation, job, item, attempt, answer } = cell;
  const base = {
    attemptId: attempt.id,
    itemId: item.item.id,
    answerId: answer?.id ?? null,
    maxPoints: item.item.points,
    now: app.clock.now(),
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };

  if (cell.config === null) return { write: { ...base, ...failedProposal("config_unreadable") } };
  const { config, warning } = cell.config;
  if (answer === null) {
    // F-GRADE-01: an absent answer is worth zero, and it is settled.
    //
    // With NO details: `gradings.details` is the question type's own
    // breakdown, and no type ever ran here. A marker of another shape is
    // handed to that type's `Review` further down the line, which is how
    // a feedback page dies on `details.cases.filter`. The record of what
    // happened is `answerId: null` beside the zero.
    return { write: { ...base, points: 0, source: "auto", state: "validated", details: null } };
  }

  const outcome = await gradeOne(app, {
    type: item.question.type,
    config,
    payload: answer.payload,
    ctx: {
      seed: attempt.seed,
      itemId: item.item.id,
      attemptId: attempt.id,
      itemPoints: item.item.points,
      now: base.now,
      runner: app.runner,
      // F-LLM-03: no model is consulted while the evaluation runs (a
      // retake's own pass); the close's pass asks it.
      ...(app.llm && !isLiveState(evaluation.state) ? { llm: app.llm } : {}),
      // The evaluation's per-type settings: what a question config
      // that says "inherit" defers to (an mcq's scoring policy).
      defaults: gradeDefaults(evaluation),
    },
  });
  if (outcome.kind === "written") {
    // A bonus item never takes points away (ADR-052): floored at 0 here, the
    // one place an automatic grade becomes an item's points.
    const points = itemPoints(outcome.grading.points, item.item.bonus);
    return { write: { ...base, ...outcome.grading, details: withWarning(outcome.grading.details, warning), points } };
  }
  return {
    runner: {
      evaluationId: evaluation.id,
      attemptId: attempt.id,
      itemId: item.item.id,
      answerId: answer.id,
      request: outcome.request,
      ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
    },
  };
}

/**
 * The details of a grading, with the warning of an instance served from a
 * fallback draw (ADR-056 §7) for the teacher; untouched otherwise. Never a
 * student's: `filterDetails` strips the key under every policy.
 */
function withWarning(details: unknown, warning: CellConfig["warning"]): unknown {
  if (warning === undefined) return details;
  const own = details !== null && typeof details === "object" && !Array.isArray(details) ? details : {};
  return { ...own, [INSTANCE_WARNING_KEY]: warning };
}

/**
 * One pass over (attempts × items). Exported because it IS the unit under
 * test: a db test calls it directly and asserts the rows it wrote, with no
 * queue and no timer anywhere.
 */
export async function runEvaluationGrading(
  app: FastifyInstance,
  job: EvaluationGradingJob,
): Promise<void> {
  const evaluation = await byId(app.db, job.evaluationId);
  if (!evaluation) return;
  const pass = await loadPass(app.db, evaluation, job);
  if (!pass) return;

  const progress = progressReporter(
    evaluation,
    pass.teacherIds,
    pass.items.length * pass.attempts.length,
  );
  const runnerJobs: RunnerGradingJob[] = [];
  // Every grading of the pass, written at the end by ONE batched writer
  // (D-01): a transaction per 500 cells instead of one per cell. A pass that
  // dies half-way writes nothing and is simply run again (idempotency).
  const writes: WriteGradingInput[] = [];
  for (const item of pass.items) {
    const configOf = readConfig(app, item);
    // An opinion poll's question has no key (ADR-014, addendum 2026-09-23):
    // there is nothing to be right about, so nothing is written — not a
    // zero per answer, which would mark the whole room wrong.
    if (!itemHasKey(item)) {
      for (const _ of pass.attempts) progress.tick();
      continue;
    }
    for (const attempt of pass.attempts) {
      const key = pairKey(attempt.id, item.item.id);
      // Idempotency (§5.4): a cell a teacher already settled is never
      // touched again, so running the job twice changes nothing.
      if (pass.standing.get(key)?.state !== "validated") {
        const answer = pass.answers.get(key) ?? null;
        const config = configOf(attempt);
        const graded = await gradeCell(app, { evaluation, job, item, config, attempt, answer });
        if ("write" in graded) writes.push(graded.write);
        else runnerJobs.push(graded.runner);
      }
      progress.tick();
    }
  }
  await writeGradings(app.db, writes);
  progress.finish(runnerJobs.length > 0 ? "runner" : "done");
  for (const runnerJob of runnerJobs) await enqueueRunnerGrading(app, runnerJob);
  // After its own write, whatever the pass filled: the grid as it stands
  // now, with every runner job that committed meanwhile (#286).
  await announceGradingReady(app, evaluation);
}

type GradeOutcome =
  | {
      kind: "written";
      grading: {
        points: number;
        source: "auto" | "llm" | "manual";
        state: "validated" | "proposed";
        details: unknown;
        comment?: string;
        confidence?: "low" | "medium" | "high";
      };
    }
  | { kind: "runner"; request: RunnerRequest };

/**
 * One answer through `type.grade`. Everything that can go wrong — an answer
 * that no longer satisfies the type's own schema, a grader that throws — ends
 * as a PROPOSAL with a machine reason, never as a crash and never as a silent
 * zero: a teacher decides.
 */
async function gradeOne(
  app: FastifyInstance,
  input: {
    type: string;
    config: unknown;
    payload: unknown;
    ctx: GradeContext;
  },
): Promise<GradeOutcome> {
  const type = typeOf(input.type);
  // W5-5: the JSON value `null` is "seen, nothing typed", and that is exactly
  // what `grade(config, null, …)` means (F-GRADE-01).
  let answer: unknown = null;
  if (input.payload !== null) {
    const parsed = type.answerSchema.safeParse(input.payload);
    if (!parsed.success) {
      return { kind: "written", grading: failedProposal("answer_invalid") };
    }
    answer = parsed.data;
  }

  let result: GradeResult<unknown>;
  try {
    result = await type.grade(input.config, answer, input.ctx);
  } catch (err) {
    app.log.error({ err, itemId: input.ctx.itemId }, "grading: grader threw");
    return { kind: "written", grading: failedProposal("grader_error") };
  }

  if (isGraded(result)) {
    return {
      kind: "written",
      grading: {
        points: round2(result.points),
        source: "auto",
        state: result.state ?? "validated",
        details: result.details,
        ...(result.comment === undefined ? {} : { comment: result.comment }),
      },
    };
  }
  if (isPendingRunner(result)) return { kind: "runner", request: result.request };

  return gradeWithLlm(app, result, input.ctx);
}

/**
 * A `pending: llm` result through the service `gradeCell` offered: the
 * model's points and confidence, as a PROPOSAL a teacher validates
 * (F-GRADE-02). The request goes as the type built it — anonymous by
 * construction, nothing is added here (F-LLM-04). The justification is the
 * TEACHER's (ADR-045, open question 27): it goes in the details under
 * `JUSTIFICATION_KEY`, which every student payload strips, and never in the
 * comment, which a validation would hand to the student. No service: a
 * proposal worth zero that says so (§5.4); a failed call: the same, with
 * `grader_error`, so a new pass retries it.
 */
async function gradeWithLlm(
  app: FastifyInstance,
  pending: PendingLlmResult,
  ctx: GradeContext,
): Promise<GradeOutcome> {
  // None without a provider, nor while the evaluation runs (F-LLM-03).
  if (!ctx.llm) return { kind: "written", grading: failedProposal("llm_not_configured", "llm") };

  let outcome: LlmGradeOutcome;
  try {
    outcome = await ctx.llm.grade(pending.request);
  } catch (err) {
    app.log.error({ err, itemId: ctx.itemId }, "grading: llm call failed");
    return { kind: "written", grading: failedProposal("grader_error", "llm") };
  }
  const own = pending.details && typeof pending.details === "object" ? pending.details : {};
  const max = pending.request.maxPoints;
  return {
    kind: "written",
    grading: {
      points: round2(Math.min(max, Math.max(0, outcome.points))),
      source: "llm",
      state: "proposed",
      details: { ...own, [JUSTIFICATION_KEY]: outcome.justification },
      confidence: outcome.confidence,
    },
  };
}

// --- The runner pass ------------------------------------------------------

async function enqueueRunnerGrading(
  app: FastifyInstance,
  job: RunnerGradingJob,
): Promise<void> {
  const queue = app.boss;
  if (!queue) {
    await runRunnerGrading(app, job);
    return;
  }
  await queue.send(GRADING_RUNNER_QUEUE, job, { priority: RUNNER_PRIORITY });
}

/**
 * The second half of a `pending: runner` grading (decision D2). The runner is
 * `app.runner`, chosen once at boot by `RUNNER_MODE`; under the default stub
 * it throws `RunnerUnavailable` and this ends as a proposal (decision D14).
 */
async function runRunnerGrading(
  app: FastifyInstance,
  job: RunnerGradingJob,
): Promise<void> {
  const db = app.db;
  const evaluation = await byId(db, job.evaluationId);
  if (!evaluation) return;
  // A cell a teacher (or a job before this one) validated is never touched.
  if (!(await isValidated(db, job.attemptId, job.itemId))) {
    await gradeWithRunner(app, evaluation, job);
  }
  // Whichever way it went, this job may be the last writer on the grid: the
  // pass that sent it may have committed its batch only after another job
  // filled this cell (#286).
  await announceGradingReady(app, evaluation);
}

/** The runner half proper: whatever happens, the cell ends with a grading (or the job is retried). */
async function gradeWithRunner(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  job: RunnerGradingJob,
): Promise<void> {
  const db = app.db;

  const item = await joinedItem(db, job.evaluationId, job.itemId);
  if (!item) return;
  const [attempt] = await db.select().from(attempts).where(eq(attempts.id, job.attemptId)).limit(1);
  if (!attempt) return;

  const now = app.clock.now();
  const base = {
    attemptId: job.attemptId,
    itemId: job.itemId,
    answerId: job.answerId,
    maxPoints: item.item.points,
    now,
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };

  const type = typeOf(item.question.type);
  if (!type.finalizeRunner) {
    await writeGrading(db, { ...base, ...failedProposal("not_finalizable") });
    return;
  }

  let outcome;
  try {
    outcome = await app.runner.run(job.request);
  } catch (err) {
    if (err instanceof RunnerBusy) throw err; // the queue retries with backoff
    const reason = err instanceof RunnerUnavailable ? "runner_unavailable" : "runner_error";
    if (reason === "runner_error") {
      app.log.error({ err, itemId: job.itemId }, "grading: runner failed");
    }
    await writeGrading(db, { ...base, ...failedProposal(reason) });
    return;
  }

  const config = loadConfig(item.question.type, itemInstance(item, attempt).version);
  const answerRow = job.answerId
    ? (await db.select().from(answers).where(eq(answers.id, job.answerId)).limit(1))[0]
    : undefined;
  const parsed =
    answerRow && answerRow.payload !== null
      ? type.answerSchema.safeParse(answerRow.payload)
      : null;

  try {
    const graded = type.finalizeRunner(
      config,
      parsed?.success ? parsed.data : null,
      {
        seed: attempt.seed,
        itemId: job.itemId,
        attemptId: job.attemptId,
        itemPoints: item.item.points,
        now,
        defaults: gradeDefaults(evaluation),
      },
      outcome,
    );
    await writeGrading(db, {
      ...base,
      points: itemPoints(graded.points, item.item.bonus),
      source: "auto",
      state: graded.state ?? "validated",
      details: graded.details,
      ...(graded.comment === undefined ? {} : { comment: graded.comment }),
    });
  } catch (err) {
    app.log.error({ err, itemId: job.itemId }, "grading: finalizeRunner threw");
    await writeGrading(db, { ...base, ...failedProposal("finalize_error") });
  }
}

/** Whether one cell holds a validated grading. */
async function isValidated(db: Db, attemptId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .select({ id: gradings.id })
    .from(gradings)
    .where(
      and(
        eq(gradings.attemptId, attemptId),
        eq(gradings.itemId, itemId),
        eq(gradings.state, "validated"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
