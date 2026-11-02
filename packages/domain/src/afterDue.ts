/**
 * Practising an exercise after its due date (ADR-122, issue #985).
 *
 * An `exercise` stays available to its classroom's students once it is over
 * (closed, being graded, released): a student may start a PRACTICE attempt
 * on it. The due date keeps its meaning — the ticker still closes the
 * exercise, and the kept attempt, the grade, the release and the statistics
 * never read a practice attempt. What lives here is the three rules the
 * server and the screens share:
 *
 *   - {@link afterDueOpen}: does this exercise take practice attempts once
 *     it is over? The teacher's switch, or its default;
 *   - {@link practiceDeadline}: when a practice attempt ends;
 *   - {@link practiceRefusal}: may this student start one now?
 *
 * Pure: the current instant is injected, nothing is read from a database.
 */
import type { EvaluationModeName, FeedbackWhen } from "./evaluationConfig.js";
import { isEvaluationOver, type EvaluationStateName } from "./itemList.js";
import type { EvaluationTiming } from "./deadline.js";

/** The teacher's switch (`settings.afterDue`): practice after the due date, or not. */
export const AFTER_DUE_SETTINGS = ["open", "hidden"] as const;
export type AfterDueSetting = (typeof AFTER_DUE_SETTINGS)[number];

/**
 * Whether practice attempts may start on this evaluation once it is over.
 *
 * Only an exercise. Never one that asks for a trusted client (Safe Exam
 * Browser, a kiosk station): those are out of scope (ADR-122 §1), whatever
 * the switch says. Otherwise the teacher's switch when set; absent, OPEN —
 * except under the feedback policy `none`, where unlimited blank attempts,
 * each with its score, would read the key out question by question: there
 * the default is HIDDEN, and a teacher who opens it anyway gets practice
 * without even the score (`practiceFeedback`'s rule, applied by the
 * results module through `feedbackGate`).
 */
export function afterDueOpen(input: {
  mode: EvaluationModeName;
  afterDue: AfterDueSetting | undefined;
  feedbackWhen: FeedbackWhen;
  safeExamBrowser?: boolean | undefined;
  kiosk?: boolean | undefined;
}): boolean {
  if (input.mode !== "exercise") return false;
  if (input.safeExamBrowser === true || input.kiosk === true) return false;
  if (input.afterDue !== undefined) return input.afterDue === "open";
  return input.feedbackWhen !== "none";
}

/** How long a practice attempt lasts when the exercise has no time limit of its own: 8 hours. */
export const PRACTICE_DEFAULT_S = 8 * 3600;

/**
 * When a practice attempt stops accepting writes, grace excluded: its start
 * plus the exercise's own time limit (a `duration` timing) and the student's
 * accommodation on it, NEVER cut at the exercise's `closes_at` — which has
 * passed; otherwise its start plus {@link PRACTICE_DEFAULT_S}. The ticker
 * expires it on this instant like any attempt (invariant 5).
 */
export function practiceDeadline(input: {
  startedAt: Date;
  timing: EvaluationTiming;
  durationS: number | null;
  timeBonusPercent: number;
}): Date {
  const own = input.timing === "duration" && input.durationS !== null && input.durationS > 0;
  const seconds = own
    ? input.durationS! + (input.durationS! * Math.max(0, input.timeBonusPercent)) / 100
    : PRACTICE_DEFAULT_S;
  return new Date(input.startedAt.getTime() + Math.round(seconds) * 1000);
}

/** The time limit a practice attempt announces, in seconds: {@link practiceDeadline}'s, accommodation excluded. */
export function practiceDurationS(input: { timing: EvaluationTiming; durationS: number | null }): number {
  return input.timing === "duration" && input.durationS !== null && input.durationS > 0
    ? input.durationS
    : PRACTICE_DEFAULT_S;
}

/** At most one new practice attempt a minute per student (ADR-122 §5). */
export const PRACTICE_COOLDOWN_MS = 60_000;

/**
 * Why a practice attempt may not start now:
 *
 * - `hidden`: the exercise does not take practice ({@link afterDueOpen});
 * - `not_over`: it is not over yet — the ordinary attempt (and its retakes)
 *   is what the student takes while it runs;
 * - `archived`: its classroom is archived, which takes no writes;
 * - `unfinished`: an attempt of the student's is still open on it (one at a
 *   time, the partial index of the schema): a stale official one left in a
 *   lobby — a practice one is resumed, never refused.
 *
 * The one-a-minute limit is {@link practiceCooldownS}, answered `429`.
 */
export const PRACTICE_REFUSALS = ["hidden", "not_over", "archived", "unfinished"] as const;
export type PracticeRefusal = (typeof PRACTICE_REFUSALS)[number];

export function practiceRefusal(input: {
  open: boolean;
  evaluationState: EvaluationStateName;
  archived: boolean;
  /** An unfinished official attempt of the student's (a practice one is resumed instead). */
  unfinishedOfficial: boolean;
}): PracticeRefusal | null {
  if (!input.open) return "hidden";
  if (!isEvaluationOver(input.evaluationState)) return "not_over";
  if (input.archived) return "archived";
  if (input.unfinishedOfficial) return "unfinished";
  return null;
}

/**
 * The seconds left before another practice attempt may start, after the
 * student's latest one was created at `lastCreatedAt`; 0 when none waits.
 */
export function practiceCooldownS(lastCreatedAt: Date | null, now: Date): number {
  if (lastCreatedAt === null) return 0;
  const left = lastCreatedAt.getTime() + PRACTICE_COOLDOWN_MS - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
