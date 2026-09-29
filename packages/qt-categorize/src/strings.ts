/**
 * The English defaults of every string the `categorize` components render.
 *
 * A component takes a partial override through its `strings` prop
 * (`StringOverrides` in `@quiz/core/client`), so `apps/web` passes the French
 * entries of its own `i18n/fr.ts` (N-I18N-01) and this package never imports
 * the app. A key ending in `.one` is the singular of its sibling (`plural`).
 */

export const categorizeEditorStrings = {
  prompt: "Statement",
  expected: "Expected answer",
  expectedHint:
    "Write the definitions, then drag each one into its column. What stays in the tray is a distractor: the student must leave it out.",
  tray: "Definitions",
  distractors: "{n} distractors (in no column)",
  "distractors.one": "1 distractor (in no column)",
  newCard: "New definition, Enter to add",
  addCard: "Add",
  cardText: "Text of card",
  removeCard: "Remove card",
  /**
   * The accessible name of a card's handle. Enter selects the card (then
   * Enter on a column moves it there); Space picks it up for the arrows.
   */
  moveCard: "Move card",
  columnLabel: "Column name",
  removeColumn: "Remove column",
  addColumn: "Add a column",
  /** An issue of one column or card, under the board: "Column name 2 — This field is empty." */
  issueAt: "{field} {n} — {message}",
  dropHere: "Drag the definitions here",
  /** The button every zone grows while a card is selected. */
  moveHere: "Move here",
  /** A drop zone while a card is selected: `{column}` is its name. */
  dropInto: "Move the selected card to {column}",
  dropIntoTray: "Move the selected card back to the tray",
  options: "Options",
  ordered: "Order matters",
  orderedHint: "In each column, the cards must follow the order of the key. The ranks are shown.",
  shuffleCards: "Shuffle cards",
  shuffleCardsHint: "Each student gets the cards in an order of their own.",
  shuffleColumns: "Shuffle columns",
  shuffleColumnsHint: "Leave it off when the order of the columns means something (before, during, after).",
  policy: "Scoring policy",
  /*
   * The three values of `CategorizeQuestionPolicy`, one word each (the pills
   * of a segmented control in a narrow column), and one line for what each
   * does to a score. "Exact" is the word `mcq` uses for the same rule.
   */
  policyInherit: "Inherited",
  policyPerItem: "Per card",
  policyAllOrNothing: "Exact",
  policyDescInherit: "Uses the policy set on the evaluation (per card by default).",
  policyDescPerItem: "Each card is worth 1/n; a distractor left out counts as right.",
  policyDescAllOrNothing: "The points only when every card is in its place.",
} as const;

export type CategorizeEditorStringKey = keyof typeof categorizeEditorStrings;

export const categorizePlayerStrings = {
  instruction: "Drag each card into its column.",
  instructionOrdered: "Drag each card into its column, in the right order.",
  noColumn: "A card may belong to no column.",
  /** Negative marking (ADR-026, ADR-036): shown on the question it applies to. */
  negativeMarking: "Wrong placements cost points; a card left in the tray costs nothing.",
  tray: "To sort",
  remaining: "{n} left",
  "remaining.one": "1 left",
  allSorted: "Everything is sorted.",
  dropHere: "Drop here",
  reset: "Put everything back",
  dropInto: "Move the selected card to {column}",
  dropIntoTray: "Move the selected card back to the tray",
} as const;

export type CategorizePlayerStringKey = keyof typeof categorizePlayerStrings;

export const categorizeReviewStrings = {
  leftOut: "Left out",
  noAnswer: "No answer",
  right: "Right",
  wrong: "Wrong",
  expected: "Expected: {column}",
  expectedRank: "Expected: {column}, rank {rank}",
  expectedNone: "Expected: no column",
  score: "Score",
  breakdown: "Cards right",
  /** The count when the key is hidden: the student's own placements only. */
  breakdownPlaced: "Placed cards right",
  /** Negative marking (ADR-026): why the score may be below zero. */
  negativeMarking: "Negative marking: wrong placements cost points.",
} as const;

export type CategorizeReviewStringKey = keyof typeof categorizeReviewStrings;

/**
 * The words of the grading table's columns (ADR-040). A column per card is
 * headed by the card itself; past {@link CATEGORIZE_GRADING_MAX_COLUMNS}
 * cards the question gets ONE summary column instead, and these are its words.
 */
export const categorizeGradingStrings = {
  /** A card left in the tray (the student's), or a distractor (the key's). */
  leftOut: "Left out",
  /** A placed card of an ordered question: its column and its rank. */
  ranked: "{column} · {rank}",
  /** The summary column's header. */
  cards: "Cards",
  /** A graded answer: how many cards are where the key puts them. */
  right: "{right}/{total} right",
  /** An answer not graded yet: how many cards left the tray. */
  placed: "{placed}/{total} placed",
  /** The key's cell of the summary column. */
  total: "{total} cards",
} as const;

export type CategorizeGradingStringKey = keyof typeof categorizeGradingStrings;
