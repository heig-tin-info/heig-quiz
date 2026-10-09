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
 *     student's result;
 *   - {@link itemStanding} and {@link partialRetakeRefusal} (ADR-091): which
 *     questions of an attempt are acquired, and whether a retake may ask only
 *     the others.
 *
 * Pure: the current instant is injected, nothing is read from a database.
 */
import { isLiveState, type EvaluationModeName } from "./evaluationConfig.js";
import type { EvaluationStateName } from "./itemList.js";
import type { NavigationMode } from "./questionProgress.js";

/** Which attempt a student's result is: the best score, or the last attempt. */
export type RetakeKeep = "best" | "last";

/**
 * What a retake asks again (ADR-091): every question (`all`, ADR-025), or
 * only the questions to review (`to_review`) — the acquired ones are carried
 * over from the previous attempt as they stand.
 */
export type RetakeScope = "all" | "to_review";

/** `settings.retakes` of an evaluation, as on the wire. */
export interface RetakePolicy {
  enabled: boolean;
  keep: RetakeKeep;
  /** The most attempts a student may take in all; `null` is unlimited. */
  maxAttempts: number | null;
  /** ADR-091; absent is `all`: read it through {@link retakeScopeOf}. */
  scope?: RetakeScope | undefined;
}

/** The scope of a retake rule: absent (every evaluation stored before ADR-091) is `all`. */
export function retakeScopeOf(policy: Pick<RetakePolicy, "scope">): RetakeScope {
  return policy.scope ?? "all";
}

/**
 * Whether a retake may ask only the questions to review (ADR-091): the
 * exercise takes retakes and the teacher chose `to_review`.
 */
export function partialRetakesOn(mode: EvaluationModeName, policy: RetakePolicy): boolean {
  return retakesOn(mode, policy) && retakeScopeOf(policy) === "to_review";
}

/**
 * ADR-091 §1: a partial retake shows the acquired questions read-only and
 * lets the student move freely between the others, which only `free`
 * navigation does — a validated checkpoint carried over would close the
 * questions before it. The server refuses any other pairing while partial
 * retakes are on ({@link partialRetakesOn}, the one rule), and the editor
 * reads the same answer.
 */
export function retakeScopeFits(
  mode: EvaluationModeName,
  policy: RetakePolicy,
  navigation: NavigationMode,
): boolean {
  return !partialRetakesOn(mode, policy) || navigation === "free";
}

/**
 * Where a question of a finished attempt stands for a partial retake
 * (ADR-091 §2):
 *
 * - `acquired`: its validated points reach its maximum. A question worth
 *   nothing (maximum 0) is acquired whatever its grading — there is nothing
 *   to win by asking it again; a bonus question (ADR-052) is acquired at its
 *   maximum like any other;
 * - `pending`: no validated grading yet (a hand-, model- or runner-graded
 *   answer nobody settled). Asked again, like `to_review`, but shown
 *   "awaiting correction", never "wrong";
 * - `to_review`: validated, below its maximum.
 */
export type ItemStanding = "acquired" | "to_review" | "pending";

export interface StandingInput {
  /** The item's points, as the evaluation gives them. */
  maxPoints: number;
  /** The VALIDATED points of the cell, or `null` when none is validated. */
  validatedPoints: number | null;
}

export function itemStanding(input: StandingInput): ItemStanding {
  if (input.maxPoints <= 0) return "acquired";
  if (input.validatedPoints === null) return "pending";
  return input.validatedPoints >= input.maxPoints ? "acquired" : "to_review";
}

/** One item with its standing, computed once by {@link itemStanding}. */
export interface StoodItem {
  id: string;
  standing: ItemStanding;
}

/** The ids of the acquired items among `items`, in their order (ADR-091 §2). */
export function acquiredItems(items: readonly StoodItem[]): string[] {
  return items.filter((item) => item.standing === "acquired").map((item) => item.id);
}

/**
 * Why a partial retake is refused, checked after {@link retakeRefusal}
 * passed (ADR-091 §3): the teacher did not choose `to_review` (`scope_all`),
 * or every question is already acquired (`nothing_to_review`) — "Redo
 * everything" is then the retake left. Two more {@link RetakeRefusal}s.
 */
export function partialRetakeRefusal(input: {
  mode: EvaluationModeName;
  retakes: RetakePolicy;
  /** The questions of the attempt the retake follows, with their standing. */
  items: readonly Pick<StoodItem, "standing">[];
}): Extract<RetakeRefusal, "scope_all" | "nothing_to_review"> | null {
  if (!partialRetakesOn(input.mode, input.retakes)) return "scope_all";
  if (input.items.every((item) => item.standing === "acquired")) return "nothing_to_review";
  return null;
}

/** The state of an attempt, as on the wire (`AttemptState`). */
export type AttemptStateName = "not_started" | "in_progress" | "submitted" | "expired";

/** An attempt is finished once it is handed in or closed; only then may another start. */
export function isFinishedAttempt(state: AttemptStateName): boolean {
  return state === "submitted" || state === "expired";
}

/**
 * Whether the grading may write on an attempt now (ADR-067): while the
 * evaluation runs, only a finished attempt — one reopened since its hand-in
 * is graded at its next; once it is over, every attempt (an attempt left
 * open by a reopen before #95 included).
 */
export function gradableNow(
  evaluationState: EvaluationStateName,
  attemptState: AttemptStateName,
): boolean {
  return !isLiveState(evaluationState) || isFinishedAttempt(attemptState);
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
 * - `max_attempts`: the maximum is reached;
 * - `scope_all`, `nothing_to_review`: a retake of the questions to review
 *   only, refused by {@link partialRetakeRefusal} (ADR-091).
 */
export type RetakeRefusal =
  | "not_allowed"
  | "not_open"
  | "closed"
  | "no_attempt"
  | "unfinished"
  | "max_attempts"
  | "scope_all"
  | "nothing_to_review";

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
