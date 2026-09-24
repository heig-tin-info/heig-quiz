/**
 * When the list of questions of an evaluation may still change (issue #79,
 * F-EVAL-03) — a pure rule (invariant 8), because it is read TWICE: by the
 * `evaluation` service, which refuses the write, and by the items step of
 * the web app, which disables the controls instead of letting them fail.
 *
 * "The item list" is everything that decides what a student is asked and
 * for how much: adding, removing and reordering items, their points and
 * milestone flags, and the question version each one is frozen on.
 *
 * Two facts freeze it, and either one is enough:
 *
 *   1. an ATTEMPT exists. A student has an item order drawn from their seed
 *      over THIS list (F-EVAL-09); changing it under them changes what they
 *      were shown. This is the rule F-EVAL-03 states for version updates, and
 *      it was the only one the service enforced before #79;
 *   2. the evaluation has been OPENED to students: `lobby` and every state
 *      after it. From `lobby` on, anybody who enters gets an attempt built on
 *      the list as it stands (`live.enterEvaluation`), so an attempt count of
 *      zero only means "nobody has come in YET" — the race the first rule
 *      alone loses, and the bug of #79 (a running evaluation that nobody had
 *      entered, or a closed one, still let a teacher remove questions).
 *
 * A teacher who needs to change the list of an opened evaluation nobody has
 * entered moves it back to `draft` first (`lobby → draft` and `closed →
 * draft` are legal while no attempt exists): the edit is then an explicit
 * step, never a side effect on something students can see.
 *
 * The union is spelled out here rather than imported from `@quiz/contracts`
 * (the domain depends on nothing but `@quiz/core`); it is structurally the
 * same type as `EvaluationState` there, and `apps/api` checks the two equal
 * at compile time.
 */
export type EvaluationStateName =
  | "draft"
  | "scheduled"
  | "lobby"
  | "running"
  | "paused"
  | "closed"
  | "grading"
  | "released";

/** Every state, in lifecycle order. */
export const EVALUATION_STATES = [
  "draft",
  "scheduled",
  "lobby",
  "running",
  "paused",
  "closed",
  "grading",
  "released",
] as const satisfies readonly EvaluationStateName[];

/** The states in which no student can have entered: nothing is open yet. */
export const ITEM_LIST_EDITABLE_STATES: readonly EvaluationStateName[] = ["draft", "scheduled"];

/**
 * Why the item list is frozen: `attempts` (somebody has an attempt) or
 * `opened` (the evaluation has been opened to students). When both hold,
 * `attempts` wins — it is the older rule and the stronger reason.
 */
export type ItemListLock = "attempts" | "opened";

export function itemListLock(
  state: EvaluationStateName,
  attemptCount: number,
): ItemListLock | null {
  if (attemptCount > 0) return "attempts";
  if (!ITEM_LIST_EDITABLE_STATES.includes(state)) return "opened";
  return null;
}

export function isItemListEditable(state: EvaluationStateName, attemptCount: number): boolean {
  return itemListLock(state, attemptCount) === null;
}
