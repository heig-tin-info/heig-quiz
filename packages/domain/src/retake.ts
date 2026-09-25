/**
 * Several attempts on an `exercise` evaluation (F-EVAL-15, ADR-025, #92).
 *
 * Two rules, read by the server and by the screens alike:
 *
 *   - {@link retakeRefusal}: may this student start another attempt now? The
 *     server decides it on every `POST /evaluations/:id/retake`; the student
 *     home reads the same answer to decide whether to offer the button;
 *   - {@link keptAttempt}: which of a student's attempts counts, `best` or
 *     `last`. The results, the grade, the CSV, the release and the student's
 *     own card all use it, so they can never disagree on which attempt is the
 *     student's result.
 *
 * Pure: the current instant is injected, nothing is read from a database.
 */
import type { EvaluationModeName } from "./evaluationConfig.js";
import type { EvaluationStateName } from "./itemList.js";

/** Which attempt a student's result is: the best score, or the last attempt. */
export type RetakeKeep = "best" | "last";

/** `settings.retakes` of an evaluation, as on the wire. */
export interface RetakePolicy {
  enabled: boolean;
  keep: RetakeKeep;
  /** The most attempts a student may take in all; `null` is unlimited. */
  maxAttempts: number | null;
}

/** The state of an attempt, as on the wire (`AttemptState`). */
export type AttemptStateName = "not_started" | "in_progress" | "submitted" | "expired";

/** An attempt is finished once it is handed in or closed; only then may another start. */
export function isFinishedAttempt(state: AttemptStateName): boolean {
  return state === "submitted" || state === "expired";
}

/**
 * Only an `exercise` may allow several attempts. An exam is one sitting, and
 * a poll is one vote per participant; the server refuses the setting on both.
 */
export function retakesAllowedFor(mode: EvaluationModeName): boolean {
  return mode === "exercise";
}

/** Whether an evaluation of this mode, with these settings, takes retakes at all. */
export function retakesOn(mode: EvaluationModeName, policy: RetakePolicy): boolean {
  return retakesAllowedFor(mode) && policy.enabled;
}

/**
 * Why a retake is refused, in the order the rule checks it:
 *
 * - `not_allowed`: the evaluation does not take retakes (an exam, or the
 *   setting is off);
 * - `not_open`: the evaluation is not `running` — before the start there is
 *   the first attempt to take, and a paused, closed or released evaluation
 *   takes no new work;
 * - `closed`: the common end (`closesAt`) has come, even if the ticker has
 *   not closed the evaluation yet;
 * - `no_attempt`: the student has not taken the first attempt yet (that one
 *   is entered, not retaken);
 * - `unfinished`: the latest attempt is still open — a retake never runs
 *   beside another attempt;
 * - `max_attempts`: the maximum is reached.
 */
export type RetakeRefusal =
  | "not_allowed"
  | "not_open"
  | "closed"
  | "no_attempt"
  | "unfinished"
  | "max_attempts";

export interface RetakeInput {
  mode: EvaluationModeName;
  retakes: RetakePolicy;
  evaluationState: EvaluationStateName;
  closesAt: Date | null;
  now: Date;
  /** The student's attempts on this evaluation, in any order. */
  attempts: readonly { attemptNumber: number; state: AttemptStateName }[];
}

/** {@link RetakeRefusal} for this student now, or `null` when a retake is allowed. */
export function retakeRefusal(input: RetakeInput): RetakeRefusal | null {
  if (!retakesOn(input.mode, input.retakes)) return "not_allowed";
  if (input.evaluationState !== "running") return "not_open";
  if (input.closesAt !== null && input.now.getTime() >= input.closesAt.getTime()) return "closed";
  const latest = latestAttempt(input.attempts);
  if (latest === null) return "no_attempt";
  if (!isFinishedAttempt(latest.state)) return "unfinished";
  const max = input.retakes.maxAttempts;
  if (max !== null && input.attempts.length >= max) return "max_attempts";
  return null;
}

/** The attempt with the highest number, or `null` for none. */
export function latestAttempt<T extends { attemptNumber: number }>(
  attempts: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const attempt of attempts) {
    if (latest === null || attempt.attemptNumber > latest.attemptNumber) latest = attempt;
  }
  return latest;
}

/** An attempt as the kept rule reads it: its number, its state and its validated points. */
export interface ScoredAttempt {
  attemptNumber: number;
  state: AttemptStateName;
  points: number;
}

/**
 * The attempt a student's result is.
 *
 * Only a FINISHED attempt competes: an attempt still being written has no
 * score yet, and a result must not drop to zero the moment a student starts
 * a retake. Among them, `best` keeps the most points — a tie goes to the
 * latest, so the attempt the student remembers is the one shown — and `last`
 * keeps the latest.
 *
 * A student with no finished attempt keeps their latest one, whatever its
 * state: the grade table lists them as they are ("in progress"), not as
 * absent. `null` only when there is no attempt at all.
 */
export function keptAttempt<T extends ScoredAttempt>(
  attempts: readonly T[],
  keep: RetakeKeep,
): T | null {
  const finished = attempts.filter((a) => isFinishedAttempt(a.state));
  if (finished.length === 0) return latestAttempt(attempts);
  if (keep === "last") return latestAttempt(finished);
  let kept: T | null = null;
  for (const attempt of finished) {
    if (
      kept === null ||
      attempt.points > kept.points ||
      (attempt.points === kept.points && attempt.attemptNumber > kept.attemptNumber)
    ) {
      kept = attempt;
    }
  }
  return kept;
}
