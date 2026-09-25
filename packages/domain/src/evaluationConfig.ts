/**
 * What an evaluation's configuration must hold before it may leave `draft`
 * (F-EVAL-04, decision D8).
 *
 * The API refuses a transition to `scheduled`, `lobby` or `running` with an
 * incomplete timing, and the configuration screen refuses to move on to the
 * launch step for the same reason. Both read the rule here, so the screen can
 * never let a teacher reach a button the server will then refuse (#76).
 */
import type { EvaluationTiming } from "./deadline.js";
import type { EvaluationStateName } from "./itemList.js";

/** The evaluation modes of F-EVAL-01, spelled as on the wire. */
export type EvaluationModeName = "exam" | "exercise" | "poll";

/**
 * A field the timing still needs. `timing` itself is the answer for an exam
 * set to `manual`: nothing can be filled in to fix it, another timing must be
 * chosen.
 */
export type TimingField = "durationS" | "opensAt" | "closesAt" | "timing";

export interface TimingInput {
  mode: EvaluationModeName;
  timing: EvaluationTiming;
  durationS: number | null;
  /** Only its presence matters here; an ISO string or a `Date`. */
  opensAt: unknown;
  closesAt: unknown;
}

/**
 * The fields to fill before the evaluation may open, in the order they sit on
 * the screen; empty when the timing is complete.
 *
 * - `duration`: a positive number of minutes per student.
 * - `deadline`: the common end AND the opening time. The opening time is the
 *   base of the accommodation in this timing: a student's extra time is
 *   `(closesAt − opensAt) × bonus` (decision D8), which has no value without it.
 * - `manual`: nothing to fill, but an `exam` must announce when it ends
 *   (F-EVAL-04), so an exam cannot use it.
 */
export function missingTimingFields(input: TimingInput): TimingField[] {
  switch (input.timing) {
    case "duration":
      return input.durationS !== null && input.durationS > 0 ? [] : ["durationS"];
    case "deadline": {
      const missing: TimingField[] = [];
      if (input.opensAt == null) missing.push("opensAt");
      if (input.closesAt == null) missing.push("closesAt");
      return missing;
    }
    case "manual":
      return input.mode === "exam" ? ["timing"] : [];
  }
}

// --- Feedback policy (F-EVAL-11, #78) --------------------------------------

/** When the student sees the correction, as on the wire (`FeedbackPolicy.when`). */
export type FeedbackWhen = "none" | "on_release" | "immediate";

/** The waiting room setting of F-EVAL-06. */
export type LobbyName = "skip" | "auto" | "manual";

export interface FeedbackContext {
  mode: EvaluationModeName;
  lobby: LobbyName;
}

/** Every policy, in the order the screen offers them. */
export const FEEDBACK_WHEN: readonly FeedbackWhen[] = ["none", "on_release", "immediate"];

/** What an evaluation falls back to when its context stops allowing `immediate`. */
export const IN_CLASS_FEEDBACK: FeedbackWhen = "on_release";

/**
 * Whether the class answers TOGETHER, in the room: an `exam`, or an
 * `exercise` given a waiting room. `immediate` feedback there hands the
 * answers to the students who validated first while the others are still
 * working (F-EVAL-11: "reserved to the exercise and poll modes"; #78).
 *
 * The waiting room is the mark of an in-class sitting because it is what
 * makes everybody start together; the glossary's `exercise` skips it
 * (docs/spec/01 §5), and the take-home preset sets it to `skip`. A `poll` is
 * live too, but its feedback is the teacher's reveal (F-LIVE-13), which the
 * spec allows explicitly.
 */
export function isInClass(ctx: FeedbackContext): boolean {
  if (ctx.mode === "exam") return true;
  if (ctx.mode === "poll") return false;
  return ctx.lobby !== "skip";
}

/** The feedback policies an evaluation may use, in screen order. */
export function allowedFeedbackWhen(ctx: FeedbackContext): readonly FeedbackWhen[] {
  return isInClass(ctx) ? FEEDBACK_WHEN.filter((w) => w !== "immediate") : FEEDBACK_WHEN;
}

export function isFeedbackAllowed(ctx: FeedbackContext, when: FeedbackWhen): boolean {
  return allowedFeedbackWhen(ctx).includes(when);
}

/**
 * `wanted` when the context allows it, otherwise {@link IN_CLASS_FEEDBACK}.
 * What the screen sends with a change that makes the current policy illegal
 * (a waiting room added, the in-class preset picked), so that the pair it
 * writes is one the server accepts.
 */
export function feedbackWhenFor(ctx: FeedbackContext, wanted: FeedbackWhen): FeedbackWhen {
  return isFeedbackAllowed(ctx, wanted) ? wanted : IN_CLASS_FEEDBACK;
}

// --- Configuration lock (F-EVAL-03, #86) -----------------------------------

/**
 * Why the configuration of an evaluation (timing, rules, scale, feedback) is
 * locked, or null when every field may change:
 *
 * - `running`: the evaluation is `running` or `paused`. Students are sitting
 *   it, whether or not one of them has entered yet: nothing that decides what
 *   they see or how long they have may move under them. Time is added from
 *   the live dashboard (`live.extendTime`), never here. The access control
 *   stays open — a student locked out by a mistyped code or allowlist must be
 *   let in mid-exam — and so do the title and the feedback policy: a
 *   forgotten answer key must be hideable during the run (#86). The in-class
 *   rule still holds there: an evaluation with a waiting room never switches
 *   to `immediate` (`isFeedbackAllowed`, #78).
 * - `attempts`: at least one attempt exists and the evaluation is not running
 *   (a closed one waiting for its release, typically). The feedback policy is
 *   still the teacher's to choose until the results are released.
 *
 * Read twice, like the item-list rule: by the `evaluation` service, which
 * refuses the write, and by the configuration screen, which disables the
 * controls instead of letting them fail.
 */
export type ConfigLock = "running" | "attempts";

/** The states in which students are sitting the evaluation. */
export const CONFIG_LIVE_STATES: readonly EvaluationStateName[] = ["running", "paused"];

/** The fields of `EvaluationPatch` each lock leaves writable. */
const WRITABLE_UNDER: Record<ConfigLock, readonly string[]> = {
  running: ["title", "accessCode", "ipAllowlist", "feedbackPolicy"],
  attempts: ["title", "accessCode", "ipAllowlist", "feedbackPolicy"],
};

export function configLock(state: EvaluationStateName, attemptCount: number): ConfigLock | null {
  if (CONFIG_LIVE_STATES.includes(state)) return "running";
  if (attemptCount > 0) return "attempts";
  return null;
}

/** Whether `field` (a key of `EvaluationPatch`) may be written under `lock`. */
export function isConfigFieldWritable(lock: ConfigLock | null, field: string): boolean {
  return lock === null || WRITABLE_UNDER[lock].includes(field);
}

/**
 * Whether the configuration is fully editable: what `EvaluationDetail.editable`
 * says, and what disables the timing and the rules on the screen.
 */
export function isConfigEditable(state: EvaluationStateName, attemptCount: number): boolean {
  return configLock(state, attemptCount) === null;
}

// --- Negative marking (ADR-026, #130) --------------------------------------

/**
 * Negative marking scores the CHOICE questions of an evaluation with a rule
 * where a wrong answer costs points (`mcqFraction`, `negativeMarking`). It is
 * a setting of the evaluation, never of a question: mixing penalised and
 * unpenalised questions in one sitting would leave the student guessing which
 * is which.
 *
 * A `poll` has no score to penalise — its votes are tallied, not graded — so
 * the server refuses the setting there, and an evaluation of that mode reads
 * it as off whatever its row says.
 */
export function negativeMarkingAllowedFor(mode: EvaluationModeName): boolean {
  return mode !== "poll";
}

/** Whether this evaluation scores its choice questions negatively. */
export function negativeMarkingOn(
  mode: EvaluationModeName,
  negativeMarking: boolean | undefined,
): boolean {
  return negativeMarkingAllowedFor(mode) && negativeMarking === true;
}

/** The question types negative marking applies to: the choice questions. */
export const NEGATIVE_MARKING_TYPES: readonly string[] = ["mcq"];

/** Whether an item of `type` may score below 0 in an evaluation where it is `on`. */
export function scoresNegatively(type: string, on: boolean): boolean {
  return on && NEGATIVE_MARKING_TYPES.includes(type);
}
