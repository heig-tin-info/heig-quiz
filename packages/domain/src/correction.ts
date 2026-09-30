/**
 * The correction of an evaluation: when the class debrief may be read, when
 * an exercise's correction may be published before its close (ADR-050), and
 * what a student may read of their own finished attempt (the feedback gate
 * of F-RES-04, ADR-025 §4).
 *
 * Read by the server — the `not_over` refusal, `POST
 * /evaluations/:id/publish-correction`, the student's feedback page and the
 * drill's key (ADR-041 §13), which all go through {@link feedbackGate} — and
 * by the screens, which offer an action only where the server accepts it.
 *
 * Pure: no instant, no database.
 */
import { isLiveState, type EvaluationModeName, type FeedbackWhen } from "./evaluationConfig.js";
import { isEvaluationOver, type EvaluationStateName } from "./itemList.js";

/**
 * Whether the class debrief (`GET /evaluations/:id/results/by-question`, its
 * projection) may be read: once the evaluation is over (ADR-033 §1), or once
 * the teacher published an exercise's correction (ADR-050).
 */
export function isDebriefOpen(evaluation: {
  state: EvaluationStateName;
  correctionPublished: boolean;
}): boolean {
  return isEvaluationOver(evaluation.state) || evaluation.correctionPublished;
}

/**
 * Why "Publish the correction" is refused (ADR-050), in the order checked:
 *
 * - `exam`: an exam's correction waits for its close and release, always;
 * - `poll`: a poll has its own reveal (F-LIVE-13) and no correction page;
 * - `not_open`: only a RUNNING exercise, paused or not (`CONFIG_LIVE_STATES`)
 *   — before the start nobody has handed anything in, and after the close
 *   the ordinary debrief and release take over.
 *
 * An exercise already published is not refused: the route is idempotent.
 */
export type CorrectionPublishRefusal = "exam" | "poll" | "not_open";

export function correctionPublishRefusal(evaluation: {
  mode: EvaluationModeName;
  state: EvaluationStateName;
}): CorrectionPublishRefusal | null {
  if (evaluation.mode === "exam") return "exam";
  if (evaluation.mode === "poll") return "poll";
  if (!isLiveState(evaluation.state)) return "not_open";
  return null;
}

/**
 * Why a student may not read their attempt's feedback now:
 *
 * - `retakes_open`: an exercise with retakes is open and its correction is
 *   not published — the SCORE only (ADR-025 §4); it also stands under
 *   `none`, where enabling retakes is the teacher's consent to the score;
 * - `no_feedback`: the policy is `none`;
 * - `attempt_open`: the attempt is not handed in yet;
 * - `results_pending`: `on_release`, and neither released nor published.
 */
export type FeedbackRefusal = "results_pending" | "no_feedback" | "attempt_open" | "retakes_open";

export type FeedbackGate = { ok: true } | { ok: false; reason: FeedbackRefusal };

/**
 * THE rule of what a student reads of one attempt (F-RES-04). A published
 * correction (ADR-050) counts as the release for the policy — `on_release`
 * and `immediate` show it — and lifts the score-only masking of an open
 * exercise with retakes; `none` stays nothing (the score included, once the
 * retakes are no longer the reason to show it). The policy's other options
 * (key, explanation, …) are applied by the caller, unchanged.
 */
export function feedbackGate(input: {
  when: FeedbackWhen;
  /** The attempt is `not_started` or `in_progress`. */
  attemptOpen: boolean;
  /** The evaluation is an exercise with retakes, still open. */
  retakesOpen: boolean;
  released: boolean;
  correctionPublished: boolean;
}): FeedbackGate {
  const { when, attemptOpen, retakesOpen, released, correctionPublished } = input;
  const scoreOnly = retakesOpen && !(correctionPublished && when !== "none");
  if (!attemptOpen && scoreOnly) return { ok: false, reason: "retakes_open" };
  if (when === "none") return { ok: false, reason: "no_feedback" };
  if (attemptOpen) return { ok: false, reason: "attempt_open" };
  if (when === "immediate") return { ok: true };
  return released || correctionPublished ? { ok: true } : { ok: false, reason: "results_pending" };
}
