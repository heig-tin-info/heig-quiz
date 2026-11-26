/**
 * Paper variants (ADR-148): the pure rules the server applies and the export
 * sheet reads, so a control never offers what the server refuses.
 *
 * A variant is one draw of the whole printed paper; an evaluation holds 1 to
 * {@link MAX_PAPER_VARIANTS}, lettered A to Z by their number — never by
 * their seed, which stays secret.
 */
import { itemListLock, type EvaluationStateName } from "./itemList.js";

/** At most one variant per letter of the alphabet. */
export const MAX_PAPER_VARIANTS = 26;

/** The letter of variant `number` (1 → A): what a page, a record and the paper entry name. */
export const variantLetter = (number: number): string => String.fromCharCode(64 + number);

/**
 * Whether the variants are fixed — no Redraw, no fewer of them: from the
 * opening on (`lobby` and every state after it), the window in which the
 * questions may no longer change either (`itemListLock`). A printed stack
 * may then be in a student's hands, and the server cannot know it was
 * printed, so variant 1 is held too. A paper copy needs the exam to have
 * run, so it falls inside that window; an evaluation moved back to `draft`
 * (only with no attempt, paper or not) is free again.
 */
export const paperVariantsLocked = (state: EvaluationStateName): boolean => itemListLock(state, 0) !== null;

/**
 * Whether two variants can differ: the items or the choices are shuffled, or
 * a question draws values. Otherwise every variant would print the same
 * paper under another letter, so only one is offered.
 */
export const variesOnPaper = (settings: { shuffleItems: boolean; shuffleChoices: boolean }, parameterized: boolean): boolean =>
  settings.shuffleItems || settings.shuffleChoices || parameterized;

/**
 * Why the count cannot go from `from` to `to`, or null: more than one where
 * nothing varies (`variants_identical`), fewer once locked
 * (`variants_locked`). Raising it stays allowed when locked: a new variant
 * changes no paper already printed.
 */
export function variantCountRefusal(
  from: number,
  to: number,
  context: { varies: boolean; locked: boolean },
): "variants_identical" | "variants_locked" | null {
  if (to > 1 && !context.varies) return "variants_identical";
  if (to < from && context.locked) return "variants_locked";
  return null;
}
