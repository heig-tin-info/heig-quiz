/**
 * Practising an exercise after its due date (ADR-122, issue #985), and a
 * released exam blank (ADR-142, issue #1037).
 *
 * An `exercise` stays available to its classroom's students once it is over
 * (closed, being graded, released): a student may start a PRACTICE attempt
 * on it. A released `exam` may be too, when its teacher allows it, for the
 * students who handed it in. The due date keeps its meaning — the ticker
 * still closes the evaluation, and the kept attempt, the grade, the release
 * and the statistics never read a practice attempt. What lives here is the
 * rules the server and the screens share:
 *
 *   - {@link afterDueOpen}: does this evaluation take practice attempts once
 *     it is over? The teacher's switch, or its default;
 *   - {@link afterDueRefusal}: may the teacher set the switch so?
 *   - {@link practiceDeadline}: when a practice attempt ends;
 *   - {@link practiceRefusal}: may this student start one now?
 *
 * Pure: the current instant is injected, nothing is read from a database.
 */
import type { EvaluationModeName, FeedbackWhen } from "./evaluationConfig.js";
import { isEvaluationOver, type EvaluationStateName } from "./itemList.js";
import { attemptDeadline, type EvaluationTiming } from "./deadline.js";

/** The teacher's switch (`settings.afterDue`): practice after the due date, or not. */
export const AFTER_DUE_SETTINGS = ["open", "hidden"] as const;
export type AfterDueSetting = (typeof AFTER_DUE_SETTINGS)[number];

/** What of the STORED feedback policy the practice of an exam reads (ADR-142 §2). */
export interface PracticeFeedback {
  when: FeedbackWhen;
  showKey: boolean;
  showAnswer: boolean;
}

/**
 * Whether an exam's stored feedback policy lets its practice open (ADR-142
 * §2): the correction at the release, with the student's answer and the key.
 * Anything less would make unlimited blank attempts an oracle — the points
 * of each try reading out a key the teacher kept hidden.
 */
export function examPracticeFeedbackOk(feedback: PracticeFeedback | undefined): boolean {
  return feedback !== undefined && feedback.when === "on_release" && feedback.showKey && feedback.showAnswer;
}

/**
 * Whether practice attempts may start on this evaluation once it is over.
 *
 * - An exercise: never one that asks for a trusted client (Safe Exam
 *   Browser, a kiosk station), out of scope (ADR-122 §1), whatever the
 *   switch says; otherwise the teacher's switch when set; absent, OPEN. The
 *   default once hid the practice where the key stayed hidden, an oracle of
 *   unlimited tries; since every exercise shows its key at the hand-in
 *   (ADR-124 §1), there is no hidden key left to protect.
 * - An exam (ADR-142): only when the teacher set the switch `open` — absent
 *   is closed — AND its stored feedback policy still shows the key at the
 *   release ({@link examPracticeFeedbackOk}): turning the key off later
 *   closes the practice. Its trusted clients do not matter: they protect the
 *   sitting, and a practice is not one.
 * - A poll: never.
 */
export function afterDueOpen(input: {
  mode: EvaluationModeName;
  afterDue: AfterDueSetting | undefined;
  safeExamBrowser?: boolean | undefined;
  kiosk?: boolean | undefined;
  /** The STORED feedback policy (an exam's reads it). */
  feedback?: PracticeFeedback | undefined;
}): boolean {
  if (input.mode === "exam") return input.afterDue === "open" && examPracticeFeedbackOk(input.feedback);
  if (input.mode !== "exercise") return false;
  if (input.safeExamBrowser === true || input.kiosk === true) return false;
  return input.afterDue !== "hidden";
}

/**
 * Why the teacher may not set the practice switch to `afterDue` (`PUT
 * /evaluations/:id/after-due`), or null:
 *
 * - `mode`: a poll has no practice (`409 after_due_locked`);
 * - `key_hidden`: opening an exam's practice while its stored policy does
 *   not show the key at the release (`422 practice_key_hidden`, ADR-142 §2).
 *
 * Closing it is always allowed; an exercise takes either value.
 */
export function afterDueRefusal(input: {
  mode: EvaluationModeName;
  afterDue: AfterDueSetting;
  feedback: PracticeFeedback;
}): "mode" | "key_hidden" | null {
  if (input.mode === "poll") return "mode";
  if (input.mode === "exam" && input.afterDue === "open" && !examPracticeFeedbackOk(input.feedback)) {
    return "key_hidden";
  }
  return null;
}

/**
 * Whether the evaluation's state takes practice: an exercise once over
 * (closed, grading, released), an exam once RELEASED only — a withdrawn
 * release stops new practice attempts (ADR-142 §1).
 */
export function practiceStateOpen(mode: EvaluationModeName, state: EvaluationStateName): boolean {
  return mode === "exam" ? state === "released" : isEvaluationOver(state);
}

/** How long a practice attempt lasts when the exercise has no time limit of its own: 8 hours. */
export const PRACTICE_DEFAULT_S = 8 * 3600;

/** Whether the exercise has a time limit per student of its own (a `duration` timing), which a practice attempt keeps. */
export function practiceOwnLimit(input: { timing: EvaluationTiming; durationS: number | null }): boolean {
  return input.timing === "duration" && input.durationS !== null && input.durationS > 0;
}

/** The time limit a practice attempt announces, in seconds: the exercise's own, or {@link PRACTICE_DEFAULT_S}. */
export function practiceDurationS(input: { timing: EvaluationTiming; durationS: number | null }): number {
  return practiceOwnLimit(input) ? input.durationS! : PRACTICE_DEFAULT_S;
}

/**
 * When a practice attempt stops accepting writes, grace excluded: a
 * `duration` attempt of {@link practiceDurationS} from its start, by the ONE
 * deadline rule (`attemptDeadline`), with no window to cut it — the
 * exercise's `closes_at` has passed. The accommodation stretches the
 * exercise's own limit, never the eight hours. The ticker expires it on this
 * instant like any attempt (invariant 5).
 */
export function practiceDeadline(input: {
  startedAt: Date;
  timing: EvaluationTiming;
  durationS: number | null;
  timeBonusPercent: number;
}): Date {
  return attemptDeadline({
    timing: "duration",
    durationS: practiceDurationS(input),
    opensAt: null,
    closesAt: null,
    closesAtShiftS: 0,
    timeBonusPercent: practiceOwnLimit(input) ? input.timeBonusPercent : 0,
    startedAt: input.startedAt,
    extraS: 0,
  })!;
}

/** At most one new practice attempt a minute per student (ADR-122 §5). */
export const PRACTICE_COOLDOWN_MS = 60_000;

/**
 * Why a practice attempt may not start now:
 *
 * - `hidden`: the evaluation does not take practice ({@link afterDueOpen});
 * - `not_over`: an exercise not over yet — the ordinary attempt (and its
 *   retakes) is what the student takes while it runs;
 * - `not_released`: an exam whose results are not released (or no longer
 *   are, ADR-142 §1);
 * - `archived`: its classroom is archived, which takes no writes;
 * - `not_taken`: an exam the student did not hand in — no finished official
 *   attempt of theirs (absent, excused: ADR-142 §3);
 * - `unfinished`: an official attempt of the student's is still open on it
 *   (one at a time, the partial index of the schema): one left `not_started`
 *   in a lobby, which the close does not end. Never expired here — an
 *   expired official attempt would enter the results; the teacher clears
 *   it. A practice one is resumed, never refused.
 *
 * The one-a-minute limit is {@link practiceCooldownS}, answered `429`.
 */
export const PRACTICE_REFUSALS = ["hidden", "not_over", "not_released", "archived", "not_taken", "unfinished"] as const;
export type PracticeRefusal = (typeof PRACTICE_REFUSALS)[number];

export function practiceRefusal(input: {
  mode: EvaluationModeName;
  open: boolean;
  evaluationState: EvaluationStateName;
  archived: boolean;
  /** A finished official attempt of the student's (an exam takes practice from those only). */
  taken: boolean;
  /** An unfinished official attempt of the student's (a practice one is resumed instead). */
  unfinishedOfficial: boolean;
}): PracticeRefusal | null {
  if (!input.open) return "hidden";
  if (!practiceStateOpen(input.mode, input.evaluationState)) return input.mode === "exam" ? "not_released" : "not_over";
  if (input.archived) return "archived";
  if (input.mode === "exam" && !input.taken) return "not_taken";
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
