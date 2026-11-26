/**
 * Paper variants (ADR-148): the pure rules the server applies and the export
 * sheet reads, so a control never offers what the server refuses.
 *
 * A variant is one draw of the whole printed paper; an evaluation holds 1 to
 * {@link MAX_PAPER_VARIANTS}, lettered A to Z by their number — never by
 * their seed, which stays secret.
 */

/** At most one variant per letter of the alphabet. */
export const MAX_PAPER_VARIANTS = 26;

/** The letter of variant `number` (1 → A): what a page, a record and the paper entry name. */
export const variantLetter = (number: number): string => String.fromCharCode(64 + number);

/**
 * Why the variants no longer move — Redraw, or fewer of them: the evaluation
 * has opened (`startedAt`), or a paper copy was entered on it. Either way a
 * printed stack may be in a student's hands; the server cannot know it was
 * printed, so variant 1 is held too.
 */
export const PAPER_VARIANTS_LOCKS = ["opened", "paper_copy"] as const;
export type PaperVariantsLock = (typeof PAPER_VARIANTS_LOCKS)[number];

export function paperVariantsLock(startedAt: Date | string | null, paperCopies: number): PaperVariantsLock | null {
  if (startedAt !== null) return "opened";
  return paperCopies > 0 ? "paper_copy" : null;
}

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
  context: { varies: boolean; lock: PaperVariantsLock | null },
): "variants_identical" | "variants_locked" | null {
  if (to > 1 && !context.varies) return "variants_identical";
  if (to < from && context.lock !== null) return "variants_locked";
  return null;
}
