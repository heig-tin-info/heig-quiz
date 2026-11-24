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
 *   - {@link PRACTICE_BY_MODE}: how each mode takes practice;
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
import { isFinishedAttempt } from "./retake.js";
import { attemptDeadline, type EvaluationTiming } from "./deadline.js";

/** The teacher's switch (`settings.afterDue`): practice after the due date, or not. */
export const AFTER_DUE_SETTINGS = ["open", "hidden"] as const;
export type AfterDueSetting = (typeof AFTER_DUE_SETTINGS)[number];

/** What of the STORED feedback policy the practice of an exam reads (ADR-142 §2). */
export interface PracticeFeedback {
  when: FeedbackWhen;
  showKey: boolean;
}

/**
 * How a mode takes practice (ADR-122, ADR-142): the one table every rule of
 * this file, the guards and the practice's conditions read, so that no
 * reader tests the mode itself. A poll takes none (`null`).
 */
export interface PracticePolicy {
  /** The switch's value when the teacher never set it. */
  defaultOpen: boolean;
  /** An evaluation asking for a trusted client (SEB, a kiosk station) takes no practice (ADR-122 §1). */
  trustedClientsHide: boolean;
  /** The stored policy must show the key at the release, or practice stays closed (ADR-142 §2). */
  needsKeyShown: boolean;
  /** The evaluation states that take practice, and the refusal outside them. */
  stateOpen: (state: EvaluationStateName) => boolean;
  stateRefusal: "not_over" | "not_released";
  /** Only a student who handed it in may practise it (ADR-142 §3). */
  needsTaken: boolean;
  /** Its trusted clients and IP allow-list protect the sitting, not the practice (ADR-142 §4). */
  ignoresSittingConditions: boolean;
  /**
   * A practice attempt's hand-in feeds the drill like any (ADR-122 §8).
   * Where it does not, the drill's cards read the OFFICIAL attempts only —
   * defence in depth should the "taken" rule ever widen (ADR-142 §6).
   */
  practiceFeedsDrill: boolean;
  /** The blank print of the series is offered (ADR-112 amendment of 2026-11-03); never where `needsTaken`. */
  printable: boolean;
  /**
   * A practice attempt reads the documents the evaluation provides (ADR-144
   * §7): an exercise's does; an exam's blank practice after the release
   * does not — its documents were the sitting's.
   */
  providesDocuments: boolean;
}

export const PRACTICE_BY_MODE: Record<EvaluationModeName, PracticePolicy | null> = {
  exercise: {
    defaultOpen: true,
    trustedClientsHide: true,
    needsKeyShown: false,
    stateOpen: isEvaluationOver,
    stateRefusal: "not_over",
    needsTaken: false,
    ignoresSittingConditions: false,
    practiceFeedsDrill: true,
    printable: true,
    providesDocuments: true,
  },
  exam: {
    defaultOpen: false,
    trustedClientsHide: false,
    needsKeyShown: true,
    stateOpen: (state) => state === "released",
    stateRefusal: "not_released",
    needsTaken: true,
    ignoresSittingConditions: true,
    practiceFeedsDrill: false,
    printable: false,
    providesDocuments: false,
  },
  poll: null,
};

/** The practice policy of `mode` ({@link PRACTICE_BY_MODE}), null where it takes none. */
export function practicePolicyOf(mode: EvaluationModeName): PracticePolicy | null {
  return PRACTICE_BY_MODE[mode];
}

/**
 * Whether a stored feedback policy lets an exam's practice open (ADR-142
 * §2): the correction at the release, with the key. Anything less would make
 * unlimited blank attempts an oracle — the points of each try reading out a
 * key the teacher kept hidden.
 */
export function practiceKeyShown(feedback: PracticeFeedback): boolean {
  return feedback.when === "on_release" && feedback.showKey;
}

/** The switch as stored, its mode's default when unset; `hidden` on a poll. */
export function afterDueSettingOf(mode: EvaluationModeName, afterDue: AfterDueSetting | undefined): AfterDueSetting {
  const policy = practicePolicyOf(mode);
  if (policy === null) return "hidden";
  return afterDue ?? (policy.defaultOpen ? "open" : "hidden");
}

/**
 * Whether practice attempts may start on this evaluation once it is over:
 * the teacher's switch, or its mode's default ({@link afterDueSettingOf});
 * never behind a trusted client where the mode says so (an exercise, ADR-122
 * §1); never under a stored policy that hides the key where the mode needs
 * it shown (an exam, ADR-142 §2) — turning the key off later closes the
 * practice. An exercise always shows its key at the hand-in (ADR-124 §1),
 * so there is nothing to protect there. A poll: never.
 */
export function afterDueOpen(input: {
  mode: EvaluationModeName;
  afterDue: AfterDueSetting | undefined;
  safeExamBrowser?: boolean | undefined;
  kiosk?: boolean | undefined;
  /** The STORED feedback policy. */
  feedback: PracticeFeedback;
}): boolean {
  const policy = practicePolicyOf(input.mode);
  if (policy === null) return false;
  if (policy.trustedClientsHide && (input.safeExamBrowser === true || input.kiosk === true)) return false;
  if (policy.needsKeyShown && !practiceKeyShown(input.feedback)) return false;
  return afterDueSettingOf(input.mode, input.afterDue) === "open";
}

/**
 * Why the teacher may not set the practice switch to `afterDue` (`PUT
 * /evaluations/:id/after-due`), or null:
 *
 * - `mode`: a poll has no practice (`409 after_due_locked`);
 * - `key_hidden`: opening an exam's practice while its stored policy does
 *   not show the key at the release (`422 practice_key_hidden`, ADR-142 §2).
 *
 * Closing it is always allowed.
 */
export function afterDueRefusal(input: {
  mode: EvaluationModeName;
  afterDue: AfterDueSetting;
  feedback: PracticeFeedback;
}): "mode" | "key_hidden" | null {
  const policy = practicePolicyOf(input.mode);
  if (policy === null) return "mode";
  if (input.afterDue === "open" && policy.needsKeyShown && !practiceKeyShown(input.feedback)) return "key_hidden";
  return null;
}

/**
 * Whether the student holds a finished OFFICIAL attempt among `attempts` —
 * not a practice one, not one a paper copy replaced: who "took" an exam
 * (ADR-142 §3). The one reading of it, for the practice route and the home.
 */
export function takenBy(
  attempts: readonly { state: string; afterDue: boolean; supersededBy: string | null }[],
): boolean {
  return attempts.some((a) => !a.afterDue && a.supersededBy === null && isFinishedAttempt(a.state));
}

/** Whether the blank print of a past series of this mode is offered (ADR-142 §5: never an exam's). */
export function practicePrintable(mode: EvaluationModeName): boolean {
  return practicePolicyOf(mode)?.printable === true;
}

/** Whether a practice attempt's hand-in feeds the drill on this mode, so its cards need not read official attempts only (ADR-142 §6). */
export function practiceFeedsDrill(mode: EvaluationModeName): boolean {
  return practicePolicyOf(mode)?.practiceFeedsDrill === true;
}

/** Whether a practice of this mode leaves the sitting's trusted clients and IP allow-list aside (ADR-142 §4). */
export function practiceIgnoresSittingConditions(mode: EvaluationModeName): boolean {
  return practicePolicyOf(mode)?.ignoresSittingConditions === true;
}

/** Whether a practice attempt of this mode reads the evaluation's provided documents (ADR-144 §7). */
export function practiceProvidesDocuments(mode: EvaluationModeName): boolean {
  return practicePolicyOf(mode)?.providesDocuments === true;
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
  /** A finished official attempt of the student's ({@link takenBy}); asked where the mode needs it. */
  taken: boolean;
  /** An unfinished official attempt of the student's (a practice one is resumed instead). */
  unfinishedOfficial: boolean;
}): PracticeRefusal | null {
  const policy = practicePolicyOf(input.mode);
  if (policy === null || !input.open) return "hidden";
  if (!policy.stateOpen(input.evaluationState)) return policy.stateRefusal;
  if (input.archived) return "archived";
  if (policy.needsTaken && !input.taken) return "not_taken";
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
