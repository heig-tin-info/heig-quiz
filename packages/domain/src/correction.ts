/**
 * The correction of an evaluation: when the class debrief may be read, when
 * an exercise's correction may be published before its close (ADR-050), the
 * policy a student reads under (ADR-124) and what a student may read of
 * their own finished attempt (the feedback gate of F-RES-04).
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
 * Since ADR-124 the publication opens the class debrief only: a student of
 * an exercise reads their own correction at the hand-in anyway.
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
 * THE feedback policy a student reads under (ADR-124 §1). An exercise always
 * shows its correction once handed in — the verdict, the points, the
 * student's answer, the key and the explanation — whatever its stored policy
 * says: an exercise is never graded, and practice without its correction
 * teaches nothing. The stored policy is kept, never rewritten, so a draft
 * switched back to an exam finds the teacher's choice again; the teacher's
 * comment and the names of hidden test cases keep their stored value. An
 * exam and a poll read their stored policy unchanged. Every reader of the
 * policy on a student's behalf goes through this function.
 */
export function effectiveFeedbackPolicy<
  P extends { when: FeedbackWhen; showAnswer: boolean; showKey: boolean; showExplanation: boolean },
>(mode: EvaluationModeName, stored: P): P {
  if (mode !== "exercise") return stored;
  return { ...stored, when: "immediate", showAnswer: true, showKey: true, showExplanation: true };
}

/**
 * Why a student may not read their attempt's feedback now:
 *
 * - `no_feedback`: the policy is `none`;
 * - `attempt_open`: the attempt is not handed in yet;
 * - `results_pending`: `on_release`, and not released yet;
 * - `exam_open`: an exam not closed yet — whatever its policy, a student
 *   reads nothing of an exam before its close, since the others are still
 *   sitting it (an `immediate` exam is refused by the contracts, docs/06 #5,
 *   but a legacy row may still carry one).
 *
 * An exercise meets `attempt_open` only: its effective policy is `immediate`
 * ({@link effectiveFeedbackPolicy}).
 */
export const FEEDBACK_REFUSALS = ["results_pending", "no_feedback", "attempt_open", "exam_open"] as const;
export type FeedbackRefusal = (typeof FEEDBACK_REFUSALS)[number];

export type FeedbackGate = { ok: true } | { ok: false; reason: FeedbackRefusal };

/**
 * THE rule of what a student reads of one attempt (F-RES-04), fed with the
 * EFFECTIVE policy's `when` ({@link effectiveFeedbackPolicy}). The policy's
 * other options (key, explanation, …) are applied by the caller. An exam
 * shows nothing before its close, whatever the policy.
 */
export function feedbackGate(input: {
  when: FeedbackWhen;
  /** The evaluation is an exam (mode `exam`). */
  exam: boolean;
  /** The evaluation is over: closed, being graded or released. */
  evaluationOver: boolean;
  /** The attempt is `not_started` or `in_progress`. */
  attemptOpen: boolean;
  released: boolean;
}): FeedbackGate {
  const { when, attemptOpen, released } = input;
  if (when === "none") return { ok: false, reason: "no_feedback" };
  if (attemptOpen) return { ok: false, reason: "attempt_open" };
  if (input.exam && !input.evaluationOver) return { ok: false, reason: "exam_open" };
  return when === "immediate" || released ? { ok: true } : { ok: false, reason: "results_pending" };
}

/**
 * Whether the student's feedback page carries a GRADE (F-RES-04): only once
 * the results are released, and never while a cell still waits for a
 * validated grading — a pending cell is not a zero, so a grade then would be
 * false. Before that the page shows its points alone, whatever the mode, as
 * the Grades page does.
 */
export function feedbackGradeShown(input: {
  released: boolean;
  /** The cells of the attempt with no validated grading. */
  pendingCount: number;
}): boolean {
  return input.released && input.pendingCount === 0;
}

/*
 * The per-question check of an exercise (ADR-124 §3): during an attempt the
 * student may CHECK one question — its verdict (at once, or once the runner
 * or the hand-in settles it), its key and its explanation — and the question
 * is then locked for the rest of that attempt; a retake gives another go.
 * Read by the server, which refuses what the rule refuses, and by the
 * player, which offers only what the server accepts.
 */

/** Only an exercise is checked: an exam shows nothing before its close, a poll has its reveal. */
export function checkAllowed(mode: EvaluationModeName): boolean {
  return mode === "exercise";
}

/**
 * Why a check of a question of an exercise ({@link checkAllowed} decides
 * that first) is refused, in the order checked:
 *
 * - `item_checked`: the question was checked already — locked for this
 *   attempt, a reopen included;
 * - `nothing_to_check`: the question holds no answer (its type's own
 *   `isAnswered`): an empty question cannot be checked.
 */
export function checkRefusal(input: {
  /** The question was checked already in this attempt. */
  checked: boolean;
  /** The question holds an answer, by its type's own rule. */
  answered: boolean;
}): "item_checked" | "nothing_to_check" | null {
  if (input.checked) return "item_checked";
  if (!input.answered) return "nothing_to_check";
  return null;
}

/**
 * THE rule of whether a student reads the correction of ONE question of
 * their attempt (ADR-124): only on an exercise, once the question is checked
 * or the attempt handed in (submitted, expired or closed). The student exit
 * of the correction (`studentItemCorrection`, `results/service.ts`) asks it
 * for each question; nothing else decides it.
 */
export function itemCorrectionShown(input: {
  mode: EvaluationModeName;
  checked: boolean;
  /** The attempt is handed in, expired or closed (`isFinishedAttempt`). */
  attemptFinished: boolean;
}): boolean {
  return checkAllowed(input.mode) && (input.checked || input.attemptFinished);
}
