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

/** The evaluation modes of F-EVAL-01. `poll` is stored and refused by every evaluation route (decision D7). */
export const EVALUATION_MODES = ["exam", "exercise", "poll"] as const;
export type EvaluationModeName = (typeof EVALUATION_MODES)[number];

/**
 * Who ended a run: the ticker past its closing time (`server`), or the
 * teacher's Close or End (`teacher`).
 */
export const EVALUATION_CLOSERS = ["server", "teacher"] as const;
export type EvaluationCloser = (typeof EVALUATION_CLOSERS)[number];

/** A field the timing still needs. */
export type TimingField = "durationS" | "opensAt" | "closesAt";

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
 *   (F-EVAL-04): it needs its safety deadline (ADR-086 §2).
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
      return input.mode === "exam" && input.closesAt == null ? ["closesAt"] : [];
  }
}

/** A time already past, by the reason the API gives for it (#178). */
export type PastTiming = "closes_at_past" | "opens_at_past";

/**
 * Whether a move from `from` to `to` would start from a time already past on
 * the SERVER's clock (#178): an end reached before the evaluation opens
 * would close it at the ticker's next pass, and a schedule for a past instant
 * would open it there. The ticker closes on `closesAt` whatever the timing —
 * a common end, the end of a window, a safety deadline (ADR-086) — so the
 * rule reads it whatever the timing too. `paused → running` is not a start:
 * the resume moves the end by the pause itself. Also what a patch of a
 * scheduled evaluation, and the ticker's own openings, are held to.
 */
export function pastTiming(
  input: { opensAt: Date | string | null; closesAt: Date | string | null },
  from: EvaluationStateName,
  to: EvaluationStateName,
  now: Date,
): PastTiming | null {
  if (from === "paused" || (to !== "scheduled" && to !== "lobby" && to !== "running")) return null;
  const past = (at: Date | string | null) => at !== null && new Date(at).getTime() <= now.getTime();
  if (past(input.closesAt)) return "closes_at_past";
  if (to === "scheduled" && past(input.opensAt)) return "opens_at_past";
  return null;
}

// --- Feedback policy (F-EVAL-11, #78) --------------------------------------

/** When the student sees the correction (`FeedbackPolicy.when`): every policy, in the order the screen offers them. */
export const FEEDBACK_WHEN = ["none", "on_release", "immediate"] as const;
export type FeedbackWhen = (typeof FEEDBACK_WHEN)[number];

/** The waiting room setting of F-EVAL-06. */
export const LOBBIES = ["skip", "auto", "manual"] as const;
export type LobbyName = (typeof LOBBIES)[number];

export interface FeedbackContext {
  mode: EvaluationModeName;
  lobby: LobbyName;
}

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
 *   the live dashboard (`live.extendTime`), never here. The network
 *   allowlist stays open — a student locked out by a mistyped prefix must be
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

/** Whether students are sitting the evaluation ({@link CONFIG_LIVE_STATES}). */
export const isLiveState = (state: string): boolean =>
  (CONFIG_LIVE_STATES as readonly string[]).includes(state);

/** The fields of `EvaluationPatch` each lock leaves writable. */
const WRITABLE_UNDER: Record<ConfigLock, readonly string[]> = {
  running: ["title", "ipAllowlist", "feedbackPolicy"],
  attempts: ["title", "ipAllowlist", "feedbackPolicy"],
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

// --- Changing the mode (ADR-092) ---------------------------------------------

/**
 * Whether the mode of an evaluation may still be changed (ADR-092): while it
 * is a draft or scheduled AND nobody has an attempt, the teacher's own
 * included. From the lobby on, students are in the room under the rules they
 * were announced. A template (never run, always a draft with no attempt)
 * always passes. A poll is never changed. One rule, read by the API
 * (`409 mode_frozen`) and by the configuration screen.
 */
export function modeChangeable(
  mode: EvaluationModeName,
  state: EvaluationStateName,
  attemptCount: number,
): boolean {
  return mode !== "poll" && (state === "draft" || state === "scheduled") && attemptCount === 0;
}

/** What a change of mode writes besides the mode itself (ADR-092 §1). */
export interface ModeChangeEffects {
  /** The feedback timing after the change: `immediate` falls back in class, nothing is ever turned on. */
  feedbackWhen: FeedbackWhen;
  /**
   * "Allow drill" FROZEN at the value the old mode gave it, so that a change
   * of mode does not silently flip the drill (`drillAllowedOn` falls back to
   * the mode's default when nothing is stored).
   */
  allowDrill: boolean;
}

/**
 * The forced consequences of moving from `from` to `to`, and only those: no
 * preset is reapplied (ADR-086, ADR-088 §2, ADR-041 §2). Going where
 * `immediate` feedback is refused (an exam, or an exercise given a waiting
 * room) turns it into {@link IN_CLASS_FEEDBACK}; `showKey` and
 * `showExplanation` are never touched, so a change of mode can only close
 * the correction, never open it.
 */
export function modeChangeEffects(
  from: EvaluationModeName,
  to: EvaluationModeName,
  current: { lobby: LobbyName; feedbackWhen: FeedbackWhen; allowDrill: boolean | undefined },
): ModeChangeEffects {
  return {
    feedbackWhen: feedbackWhenFor({ mode: to, lobby: current.lobby }, current.feedbackWhen),
    allowDrill: drillAllowedOn(from, current.allowDrill),
  };
}

// --- Negative marking (ADR-026, #130) --------------------------------------

/**
 * Negative marking scores the CHOICE questions of an evaluation — `mcq` and
 * `categorize` (ADR-036) — with a rule where a wrong answer costs points
 * (`mcqFraction`, `categorizeFraction`). It is
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

/**
 * The confined clients an exam may require (ADR-051 §2): Safe Exam Browser,
 * or a kiosk station — each also the kind of the confined session it opens.
 * THE list: `@quiz/contracts` builds `TrustedClient` and `SESSION_KINDS` from
 * it, and the API's `confined()` reads it.
 */
export const TRUSTED_CLIENTS = ["seb", "kiosk"] as const;
export type TrustedClient = (typeof TRUSTED_CLIENTS)[number];

/** Whether a session kind is a trusted client's, i.e. a confined session. */
export const isTrustedClient = (kind: string): kind is TrustedClient =>
  (TRUSTED_CLIENTS as readonly string[]).includes(kind);

/** Only an exam may require a trusted client: the settings screen offers the choice there alone. */
export function trustedClientsAllowedFor(mode: EvaluationModeName): boolean {
  return mode === "exam";
}

/**
 * The trusted clients an evaluation accepts (ADR-027, ADR-051 §2), in this
 * order: `seb`, then `kiosk`. Empty means the evaluation is sat in the
 * portal; otherwise ONLY through one of the kinds listed. Both switches are
 * an exam's, inert on any other mode whatever its row says. The one reader
 * of whether they are IN FORCE: every rule that depends on them (who sits,
 * the `.seb`, the student's card, the launch summary) asks this.
 */
export function trustedClientsOf(
  mode: EvaluationModeName,
  settings: { safeExamBrowser?: boolean | undefined; kiosk?: boolean | undefined },
): TrustedClient[] {
  if (!trustedClientsAllowedFor(mode)) return [];
  const on: Record<TrustedClient, boolean | undefined> = { seb: settings.safeExamBrowser, kiosk: settings.kiosk };
  return TRUSTED_CLIENTS.filter((client) => on[client] === true);
}

/**
 * Whether the questions of this evaluation become drill cards (ADR-041 §2):
 * the teacher's choice when there is one, else ON for an exercise and OFF
 * for an exam; never on a poll, whose questions are opinions or warm-ups
 * (ADR-041 §10).
 */
export function drillAllowedOn(mode: EvaluationModeName, allowDrill: boolean | undefined): boolean {
  if (!drillModeOf(mode)) return false;
  return allowDrill ?? mode === "exercise";
}

/** A poll never feeds the drill: the half of both rules below and above, and of the screen's drill setting. */
export const drillModeOf = (mode: EvaluationModeName): boolean => mode !== "poll";

/**
 * Whether "Allow drill" may still change (ADR-041 §10, item 3): until the
 * release, and never on a poll. The API's writer, the settings screen and the
 * mock all ask this one rule.
 */
export function allowDrillWritable(mode: EvaluationModeName, state: EvaluationStateName): boolean {
  return drillModeOf(mode) && state !== "released";
}

/**
 * Only an exam pauses (docs/spec/01 §1 glossary): the server refuses the
 * transition on any other mode, and the dashboard offers Pause on an exam alone.
 */
export function pausableMode(mode: EvaluationModeName): boolean {
  return mode === "exam";
}

// --- The integrity journal (F-EVAL-13, ADR-088) ------------------------------

/**
 * `logVisibility` at creation: on for an exam, off for an exercise (the
 * teacher may switch it on) and for a poll, which never journals. Read once,
 * when the evaluation is created; a stored evaluation keeps its value.
 */
export function logVisibilityDefault(mode: EvaluationModeName): boolean {
  return mode === "exam";
}

/** Whether this evaluation keeps the integrity journal; a poll never does, whatever its row says. */
export function integrityJournalOn(mode: EvaluationModeName, logVisibility: boolean): boolean {
  return mode !== "poll" && logVisibility;
}

// --- The calculator provided (ADR-069) ---------------------------------------

/** What an evaluation provides (`settings.calculator`); absent is `none`. */
export const CALCULATOR_MODES = ["none", "standard", "scientific"] as const;
export type CalculatorMode = (typeof CALCULATOR_MODES)[number];

/** A poll has nothing to compute: the server refuses the setting there. */
export function calculatorAllowedFor(mode: EvaluationModeName): boolean {
  return mode !== "poll";
}

/** The calculator a student gets on this evaluation; a poll's is `none` whatever its row says. */
export function calculatorOn(mode: EvaluationModeName, calculator: CalculatorMode | undefined): CalculatorMode {
  return calculatorAllowedFor(mode) ? (calculator ?? "none") : "none";
}

// --- The notepad provided (ADR-090) -----------------------------------------

/**
 * What an evaluation provides (`settings.notepad`); absent is `none`.
 * `provided_no_clipboard` is the same notepad with copy, cut, paste and drag
 * blocked inside it — inside it only: the answer fields are untouched.
 */
export const NOTEPAD_MODES = ["none", "provided", "provided_no_clipboard"] as const;
export type NotepadMode = (typeof NOTEPAD_MODES)[number];

/** A poll has nothing to work out: the server refuses the setting there, as the calculator's. */
export const notepadAllowedFor = calculatorAllowedFor;

/** The notepad a student gets on this evaluation; a poll's is `none` whatever its row says. */
export function notepadOn(mode: EvaluationModeName, notepad: NotepadMode | undefined): NotepadMode {
  return notepadAllowedFor(mode) ? (notepad ?? "none") : "none";
}

/** Whether this evaluation scores its choice questions negatively. */
export function negativeMarkingOn(
  mode: EvaluationModeName,
  negativeMarking: boolean | undefined,
): boolean {
  return negativeMarkingAllowedFor(mode) && negativeMarking === true;
}

/**
 * The question types negative marking applies to: the choice questions, and
 * `categorize`, where placing a card is a choice among the columns (ADR-036).
 */
export const NEGATIVE_MARKING_TYPES: readonly string[] = ["mcq", "categorize"];

/**
 * Whether an item of `type` may score below 0 in an evaluation where it is
 * `on`. Never a bonus item: its score is floored at 0 (`itemPoints`, ADR-052).
 */
export function scoresNegatively(type: string, on: boolean, bonus: boolean): boolean {
  return on && !bonus && NEGATIVE_MARKING_TYPES.includes(type);
}
