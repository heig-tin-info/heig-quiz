/**
 * The LLM pass (`grading.llm`, ADR-063, see `jobs.ts`): the one way to the
 * model, for one answer.
 */
import type { FastifyInstance } from "fastify";

import { justificationOf } from "@quiz/contracts";
import { isLiveState, itemPoints, maskNames } from "@quiz/domain";

import type { answers } from "../../db/schema.js";
import { askGrader } from "../llm/service.js";
import { byId, peopleOf, type EvaluationRecord } from "../evaluation/service.js";
import { isValidated, type EvaluationGradingJob, type LlmGradingJob } from "./passCommon.js";
import { announceGradingReady } from "./ready.js";
import type { GradingRecord } from "./records.js";
import { writeGrading } from "./writer.js";

/**
 * Whether this pass may ask a model: a service, a key behind it, and an
 * evaluation that no longer runs (F-LLM-03: a hand-in's own pass leaves the
 * essay to the close's). Asked once per pass.
 */
export async function offersLlm(app: FastifyInstance, evaluation: EvaluationRecord): Promise<boolean> {
  return !!app.llm && !isLiveState(evaluation.state) && (await app.llm.ready());
}

/**
 * A cell whose standing grading is a SUCCESSFUL model proposal for the same
 * answer is not asked again: the model is neither free nor deterministic,
 * and its new reply would replace the one a teacher may be reading. A
 * re-grade asks again (its note says why), and so does a failure, which
 * carries no justification.
 */
export function keepsLlmProposal(
  standing: GradingRecord,
  answer: typeof answers.$inferSelect | null,
  job: EvaluationGradingJob,
): boolean {
  return (
    job.regradeNote === undefined &&
    standing.source === "llm" &&
    standing.state === "proposed" &&
    standing.answerId === answer?.id &&
    justificationOf(standing.details) !== null
  );
}

/**
 * The second half of a `pending: llm` grading, and the one way to the model:
 * the answer masked of the evaluation's names (N-DATA-05), then the model's
 * points, confidence and criteria, as a PROPOSAL a teacher validates
 * (F-GRADE-02). The justification and the rest of the reply are the
 * TEACHER's (ADR-045, ADR-063 §4): under `JUSTIFICATION_KEY` and `AI_KEY`,
 * which every student payload strips, never in the comment a validation
 * would hand to the student. A failed call: a proposal worth zero that says
 * why (§5.4).
 *
 * A practice attempt after the due date (ADR-122 §6, the product owner's
 * choice): the model's successful reply is the practice result, VALIDATED
 * as it stands — no teacher reads a practice attempt, and it counts nowhere.
 * A failure stays a proposal: the cell reads "not graded in practice".
 */
export async function runLlmGrading(app: FastifyInstance, job: LlmGradingJob): Promise<void> {
  const db = app.db;
  const evaluation = await byId(db, job.evaluationId);
  // F-LLM-03 again: an evaluation reopened since the pass is not graded
  // while it runs; the pass of its next close asks.
  if (!evaluation || isLiveState(evaluation.state)) return;
  if (!(await isValidated(db, job.attemptId, job.itemId))) {
    const base = {
      attemptId: job.attemptId,
      itemId: job.itemId,
      answerId: job.answerId,
      maxPoints: job.request.maxPoints,
      now: app.clock.now(),
      ...(job.regradeNote === undefined ? {} : { regradeNote: job.regradeNote }),
    };
    const proposal = await askModel(app, evaluation, job);
    const settled = job.practice === true && justificationOf(proposal.details) !== null;
    await writeGrading(db, { ...base, ...proposal, ...(settled ? { state: "validated" as const } : {}) });
  }
  await announceGradingReady(app, evaluation);
}

/** The model's proposal for one answer, or the failed proposal that says why. */
async function askModel(app: FastifyInstance, evaluation: EvaluationRecord, job: LlmGradingJob) {
  const request = { ...job.request, answer: maskNames(job.request.answer, await peopleOf(app.db, evaluation)) };
  // The pass's purpose: billed to the evaluation's author, exempt from their share (ADR-058 L2).
  const proposal = await askGrader(app.llm, request, {
    billedTo: evaluation.createdBy,
    purpose: "grade",
    own: job.details,
    log: app.log,
    context: { itemId: job.itemId },
  });
  return { ...proposal, points: itemPoints(proposal.points), source: "llm" as const, state: "proposed" as const };
}
