/**
 * The runner pass (`grading.runner`, see `jobs.ts`): the second half of a
 * `pending: runner` grading, for one answer.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { RunnerBusy, RunnerUnavailable } from "@quiz/core/server";
import { gradableNow, itemPoints } from "@quiz/domain";

import { answers, attempts } from "../../db/schema.js";
import type { JobTry } from "../../jobs.js";
import { byId, gradeDefaults, joinedItem, type EvaluationRecord } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { itemInstance } from "../pool/service.js";
import {
  failedProposal,
  isValidated,
  passGuard,
  type AttemptRecord,
  type RunnerGradingJob,
} from "./passCommon.js";
import { announceGradingReady } from "./ready.js";
import { writeGradings, type WriteGradingInput, type WriteGuard } from "./writer.js";

/**
 * The second half of a `pending: runner` grading (decision D2). The runner is
 * `app.runner`, chosen once at boot by `RUNNER_MODE`; under the default stub
 * it throws `RunnerUnavailable` and this ends as a proposal (decision D14).
 * Run inline (no queue), every call is the last try. Exported for its tests.
 */
export async function runRunnerGrading(
  app: FastifyInstance,
  job: RunnerGradingJob,
  tried: JobTry = { lastTry: true },
): Promise<void> {
  const db = app.db;
  const evaluation = await byId(db, job.evaluationId);
  if (!evaluation) return;
  // A cell a teacher (or a job before this one) validated is never touched.
  if (!(await isValidated(db, job.attemptId, job.itemId))) {
    await gradeWithRunner(app, evaluation, job, tried);
  }
  // Whichever way it went, this job may be the last writer on the grid: the
  // pass that sent it may have committed its batch only after another job
  // filled this cell (#286).
  await announceGradingReady(app, evaluation);
}

/**
 * The runner half proper: whatever happens, the cell ends with a grading —
 * unless the job is retried, or stale (ADR-067).
 */
async function gradeWithRunner(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  job: RunnerGradingJob,
  tried: JobTry,
): Promise<void> {
  const db = app.db;

  const item = await joinedItem(db, job.evaluationId, job.itemId);
  if (!item) return;
  const [attempt] = await db.select().from(attempts).where(eq(attempts.id, job.attemptId)).limit(1);
  if (!attempt) return;
  const answerRow = job.answerId
    ? (await db.select().from(answers).where(eq(answers.id, job.answerId)).limit(1))[0]
    : undefined;
  // A cheap early exit, so a stale job never takes a runner slot. What
  // decides is the guard of the write, under the attempt's lock.
  if (isStale(evaluation, attempt, answerRow, job)) return;

  const now = app.clock.now();
  const base = {
    attemptId: job.attemptId,
    itemId: job.itemId,
    answerId: job.answerId,
    maxPoints: item.item.points,
    now,
    ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
  };
  const write = (grading: Omit<WriteGradingInput, keyof typeof base>) =>
    writeGradings(db, [{ ...base, ...grading }], runnerGuard(job));

  const type = typeOf(item.question.type);
  if (!type.finalizeRunner) {
    await write(failedProposal("not_finalizable"));
    return;
  }

  const run = await app.runner.run(job.request).then(
    (outcome) => ({ outcome }),
    (err: unknown) => ({ err }),
  );
  if ("err" in run) {
    // Saturation is worth a retry, with the same job (its `finalizeState`
    // included): pg-boss retries with backoff. The last try settles the cell
    // as a proposal, so the grid completes and `grading_ready` goes out
    // (ADR-101); the teacher's "Run grading again" clears it.
    if (run.err instanceof RunnerBusy) {
      if (!tried.lastTry) throw run.err;
      await write(failedProposal("runner_busy"));
      return;
    }
    const reason = run.err instanceof RunnerUnavailable ? "runner_unavailable" : "runner_error";
    if (reason === "runner_error") {
      app.log.error({ err: run.err, itemId: job.itemId }, "grading: runner failed");
    }
    await write(failedProposal(reason));
    return;
  }

  const config = loadConfig(item.question.type, itemInstance(item, attempt).version);
  const parsed =
    answerRow && answerRow.payload !== null
      ? type.answerSchema.safeParse(answerRow.payload)
      : null;

  let graded;
  try {
    graded = type.finalizeRunner(
      config,
      parsed?.success ? parsed.data : null,
      {
        seed: attempt.seed,
        itemId: job.itemId,
        attemptId: job.attemptId,
        itemPoints: item.item.points,
        now,
        defaults: gradeDefaults(evaluation),
        finalizeState: job.finalizeState,
      },
      run.outcome,
    );
  } catch (err) {
    app.log.error({ err, itemId: job.itemId }, "grading: finalizeRunner threw");
    await write(failedProposal("finalize_error"));
    return;
  }
  await write({
    points: itemPoints(graded.points),
    source: "auto",
    state: graded.state ?? "validated",
    details: graded.details,
    ...(graded.comment === undefined ? {} : { comment: graded.comment }),
  });
}

/**
 * Whether a runner job no longer describes its cell (ADR-067): its attempt
 * was reopened since the hand-in that sent it, while the evaluation runs, or
 * its answer was rewritten since (a reopened attempt handed in again, whose
 * own pass sent a job of its own). Writing would grade an answer the student
 * no longer holds, and the pass never re-grades a validated cell. A checked
 * question's job (ADR-124 §3) is current while its attempt is still open:
 * the check locked the answer it was built from.
 */
function isStale(
  evaluation: Pick<EvaluationRecord, "state" | "mode">,
  attempt: Pick<AttemptRecord, "state" | "afterDue">,
  answer: { revision: number; checkedAt: Date | null } | undefined,
  job: RunnerGradingJob,
): boolean {
  const cell = { mode: evaluation.mode, checked: answer?.checkedAt != null };
  if (!gradableNow(evaluation.state, attempt, cell)) return true;
  return answer !== undefined && rewritten(answer.revision, job);
}

/** Whether the answer moved past the revision the job was built from (none: current). */
function rewritten(revision: number, job: RunnerGradingJob): boolean {
  return job.revision !== undefined && revision !== job.revision;
}

/** {@link passGuard}, and the answer still at the revision the job was built from. */
function runnerGuard(job: RunnerGradingJob): WriteGuard {
  return async (tx, inputs) => {
    const kept = await passGuard()(tx, inputs);
    if (kept.length === 0 || job.answerId === null) return kept;
    // Under the attempt's lock: an answer is written only while its attempt
    // is open, and opening it again takes that lock.
    const [answer] = await tx
      .select({ revision: answers.revision })
      .from(answers)
      .where(eq(answers.id, job.answerId))
      .limit(1);
    return answer !== undefined && rewritten(answer.revision, job) ? [] : kept;
  };
}
