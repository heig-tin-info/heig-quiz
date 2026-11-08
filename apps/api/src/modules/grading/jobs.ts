/**
 * The grading jobs (PLAN-MVP §5.4, docs/05 §5.6).
 *
 * ```
 * POST /close  or  ticker auto-close
 *       └─▶ grading.evaluation { evaluationId }   (one job per request, #273)
 * an exercise's attempt handed in, expired or closed while it runs (ADR-067)
 *       └─▶ grading.evaluation { evaluationId, attemptIds: [that attempt] }
 *           (an exam waits for its close; a reopen stands the attempt's
 *            automatic gradings down, and its next hand-in grades it again)
 *
 * grading.evaluation, for each (attempt × item):
 *    an attempt not finished while the eval runs  → skip: its next hand-in grades it
 *    a validated grading already stands           → skip          (idempotent)
 *    no answer row at all                         → 0, validated, auto  (F-GRADE-01)
 *      … on a paper copy, an item of free zones only → 0, proposed, 'paper_free_zone'
 *        (ADR-125 §14: an essay the staff did not type in; a person decides)
 *    type.grade() returns 'graded'                → validated (or proposed if it says so)
 *    type.grade() returns pending: 'runner'       → grading.runner, low priority
 *    a successful LLM proposal for the same answer → kept, unless a re-grade (ADR-063 §3)
 *    type.grade() returns pending: 'llm'          → grading.llm (no model while the
 *                                                   evaluation runs, nor without a key:
 *                                                   the type then proposes by hand)
 *    then, the grid complete                      → grading_ready, once (`ready.ts`)
 *
 * grading.runner, for one answer (GRADING_RUNNER_CONCURRENCY at a time, default 1):
 *    attempt reopened, or answer rewritten, since → nothing: a later pass sends its own
 *    runner.run() → type.finalizeRunner()         → validated
 *    RunnerUnavailable (the stub, decision D14)   → proposed, reason 'runner_unavailable'
 *    RunnerBusy (queue full, or waited too long)  → rethrown, pg-boss retries (ADR-101)
 *      … on the last try                          → proposed, reason 'runner_busy'
 *    anything else                                → proposed, reason 'runner_error'
 *    (a program that overruns is a result: the runner reports its cases
 *     timed out within the request's budget, never a retry)
 *    then, the grid complete                      → grading_ready, once (`ready.ts`)
 *
 * grading.llm, for one answer (ADR-063):
 *    the answer masked of the evaluation's names → app.llm.grade() → proposed, source 'llm',
 *                                                   its confidence, criteria and model
 *    budget_exhausted                             → proposed, reason 'llm_budget'
 *    no key any more                              → proposed, reason 'llm_not_configured'
 *    anything else                                → proposed, reason 'grader_error'
 *    then, the grid complete                      → grading_ready, once (`ready.ts`)
 * ```
 *
 * Nothing here ever blocks: a machine with no container engine still closes,
 * grades, releases and exports an evaluation containing `code` questions —
 * the code answers simply arrive in the panel as proposals a teacher settles.
 *
 * This file queues and registers the passes; each lives in its own file:
 * `evaluationPass.ts`, `runnerPass.ts` and `llmPass.ts`, with what they
 * share in `passCommon.ts`.
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import {
  GRADING_EVALUATION_QUEUE,
  GRADING_LLM_QUEUE,
  GRADING_RUNNER_QUEUE,
  type JobQueue,
} from "../../jobs.js";
import { runEvaluationGrading } from "./evaluationPass.js";
import { runLlmGrading } from "./llmPass.js";
import type { EvaluationGradingJob, LlmGradingJob, RunnerGradingJob } from "./passCommon.js";
import { runRunnerGrading } from "./runnerPass.js";

export { checkGrading, enqueueCheckRun, runEvaluationGrading, writeCheckGrading } from "./evaluationPass.js";
export type { RunnerGradingJob } from "./passCommon.js";
export { runRunnerGrading } from "./runnerPass.js";

/** Two calls at a time: a class of essays in minutes, without a burst the provider would rate-limit. */
const LLM_CONCURRENCY = 2;

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

/**
 * Registers the three handlers. Called once, from `buildApp`.
 *
 * `grading.runner` takes `GRADING_RUNNER_CONCURRENCY` jobs at a time (one by
 * default, ADR-067): the runner has one FIFO for the grading and the
 * students' Run clicks alike (`RUNNER_CONCURRENCY`), and an exercise graded
 * at every hand-in must never fill it while the class is still running code.
 */
export async function registerGradingJobs(
  app: FastifyInstance,
  queue: JobQueue,
  config: Pick<AppConfig, "GRADING_RUNNER_CONCURRENCY">,
): Promise<void> {
  await queue.createQueue(GRADING_EVALUATION_QUEUE, { retryLimit: 1 });
  await queue.createQueue(GRADING_RUNNER_QUEUE, {
    retryLimit: 2,
    retryBackoff: true,
    retryDelay: 5,
  });
  await queue.work<EvaluationGradingJob>(GRADING_EVALUATION_QUEUE, (data) =>
    runEvaluationGrading(app, data),
  );
  await queue.work<RunnerGradingJob>(GRADING_RUNNER_QUEUE, (data, job) => runRunnerGrading(app, data, job), {
    localConcurrency: config.GRADING_RUNNER_CONCURRENCY,
  });
  // No retry: the provider's SDK already retries a rate limit, and a cap
  // reached now is still reached in a minute (ADR-063 §2).
  await queue.createQueue(GRADING_LLM_QUEUE, { retryLimit: 0 });
  await queue.work<LlmGradingJob>(GRADING_LLM_QUEUE, (data) => runLlmGrading(app, data), {
    localConcurrency: LLM_CONCURRENCY,
  });
}
