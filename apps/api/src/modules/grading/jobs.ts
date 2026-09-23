/**
 * The grading jobs (PLAN-MVP §5.4, docs/05 §5.6).
 *
 * ```
 * POST /close  or  ticker auto-close
 *       └─▶ grading.evaluation { evaluationId }        (singletonKey = evaluationId)
 *
 * grading.evaluation, for each (attempt × item):
 *    a validated grading already stands           → skip          (idempotent)
 *    no answer row at all                         → 0, validated, auto  (F-GRADE-01)
 *    type.grade() returns 'graded'                → validated (or proposed if it says so)
 *    type.grade() returns pending: 'runner'       → grading.runner, low priority
 *    type.grade() returns pending: 'llm'          → proposed, reason 'llm_not_configured'
 *
 * grading.runner, for one answer:
 *    runner.run() → type.finalizeRunner()         → validated
 *    RunnerUnavailable (the stub, decision D14)   → proposed, reason 'runner_unavailable'
 *    RunnerBusy                                   → rethrown, pg-boss retries
 *    anything else                                → proposed, reason 'runner_error'
 * ```
 *
 * Nothing here ever blocks: a machine with no container engine still closes,
 * grades, releases and exports an evaluation containing `code` questions —
 * the code answers simply arrive in the panel as proposals a teacher settles.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";

import type { GradeContext, GradeResult, RunnerRequest } from "@quiz/core/server";
import { RunnerBusy, RunnerUnavailable, isGraded, isPendingRunner } from "@quiz/core/server";
import { round2 } from "@quiz/domain";

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
  joinedItems,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as events from "./events.js";
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
 * are wire values: `reasonOf` / `progressOf` (`service.ts`) and the web panel
 * read them back, so the set is closed here rather than spelled at each site.
 */
type ProposalReason =
  | "config_unreadable"
  | "answer_invalid"
  | "grader_error"
  | "llm_not_configured"
  | "not_finalizable"
  | "runner_unavailable"
  | "runner_error"
  | "finalize_error";

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
  await queue.send(GRADING_EVALUATION_QUEUE, job, { singletonKey: job.evaluationId });
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
    .where(eq(attempts.evaluationId, evaluation.id));
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

/**
 * The stored config of one item through `loadConfig`, the ONE read pipeline
 * (§1.6): migrated and parsed once per item, not once per attempt. `null`
 * when it cannot be read, and every cell of the item becomes a proposal.
 */
function readConfig(app: FastifyInstance, item: JoinedItem): unknown {
  try {
    return loadConfig(item.question.type, {
      config: item.version.config,
      configVersion: item.version.configVersion,
    });
  } catch (err) {
    app.log.error({ err, itemId: item.item.id }, "grading: unreadable question config");
    return null;
  }
}

/**
 * One cell that no teacher has settled yet: the grading to write, or `null`
 * when it went to the runner. The pass writes the gradings in one batch.
 */
async function gradeCell(
  app: FastifyInstance,
  cell: {
    evaluation: EvaluationRecord;
    job: EvaluationGradingJob;
    item: JoinedItem;
    config: unknown;
    attempt: AttemptRecord;
    answer: typeof answers.$inferSelect | null;
  },
): Promise<WriteGradingInput | null> {
  const { evaluation, job, item, config, attempt, answer } = cell;
  const base = {
    attemptId: attempt.id,
    itemId: item.item.id,
    answerId: answer?.id ?? null,
    maxPoints: item.item.points,
    now: app.clock.now(),
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };

  if (config === null) return { ...base, ...failedProposal("config_unreadable") };
  if (answer === null) {
    // F-GRADE-01: an absent answer is worth zero, and it is settled.
    //
    // With NO details: `gradings.details` is the question type's own
    // breakdown, and no type ever ran here. A marker of another shape is
    // handed to that type's `Review` further down the line, which is how
    // a feedback page dies on `details.cases.filter`. The record of what
    // happened is `answerId: null` beside the zero.
    return { ...base, points: 0, source: "auto", state: "validated", details: null };
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
      // The evaluation's per-type settings: what a question config
      // that says "inherit" defers to (an mcq's scoring policy).
      defaults: gradeDefaults(evaluation),
    },
  });
  if (outcome.kind === "written") return { ...base, ...outcome.grading };
  await enqueueRunnerGrading(app, {
    evaluationId: evaluation.id,
    attemptId: attempt.id,
    itemId: item.item.id,
    answerId: answer.id,
    request: outcome.request,
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  });
  return null;
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
  let queuedRunner = 0;
  // Every grading of the pass, written at the end by ONE batched writer
  // (D-01): a transaction per 500 cells instead of one per cell. A pass that
  // dies half-way writes nothing and is simply run again (idempotency).
  const writes: WriteGradingInput[] = [];
  for (const item of pass.items) {
    const config = readConfig(app, item);
    for (const attempt of pass.attempts) {
      const key = pairKey(attempt.id, item.item.id);
      // Idempotency (§5.4): a cell a teacher already settled is never
      // touched again, so running the job twice changes nothing.
      if (pass.standing.get(key)?.state !== "validated") {
        const answer = pass.answers.get(key) ?? null;
        const grading = await gradeCell(app, { evaluation, job, item, config, attempt, answer });
        if (grading) writes.push(grading);
        else queuedRunner += 1;
      }
      progress.tick();
    }
  }
  await writeGradings(app.db, writes);
  progress.finish(queuedRunner > 0 ? "runner" : "done");
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

  // `pending: llm` — phase 2. The MVP has no provider configured, so the
  // answer arrives in the panel as a proposal worth zero (§5.4).
  return { kind: "written", grading: failedProposal("llm_not_configured", "llm") };
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
  if (await hasValidated(db, job.attemptId, job.itemId)) return;

  const items = await joinedItems(db, job.evaluationId);
  const item = items.find((i) => i.item.id === job.itemId);
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

  const config = loadConfig(item.question.type, {
    config: item.version.config,
    configVersion: item.version.configVersion,
  });
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
      points: round2(graded.points),
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

async function hasValidated(db: Db, attemptId: string, itemId: string): Promise<boolean> {
  const [row] = await db
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
  return row !== undefined;
}
