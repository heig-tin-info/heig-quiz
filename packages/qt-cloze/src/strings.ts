/**
 * English defaults for the `cloze` components; `apps/web` passes its French
 * entries through the `strings` prop (see `StringOverrides` in
 * `@quiz/core/client`).
 */

export const clozeEditorStrings = {
  text: "Text with blanks",
  textHint: "A blank is {{answer}}. Use | for alternatives, = for a dropdown, # for a number, / for a regex.",
  caseSensitive: "Case sensitive",
  shuffleOptions: "Shuffle the dropdown options",
  blanks: "Blanks",
  blanksHint: "What the parser understood, in order of appearance.",
  noBlank: "No blank yet.",
  blank: "Blank",
  kind: "Kind",
  weight: "Weight",
  expected: "Expected",
  preview: "Preview",
} as const;

export type ClozeEditorStringKey = keyof typeof clozeEditorStrings;

export const clozePlayerStrings = {
  blank: "Blank",
  choose: "Choose…",
  hint: "Fill every blank. Your answers are saved as you type.",
} as const;

export type ClozePlayerStringKey = keyof typeof clozePlayerStrings;

export const clozeReviewStrings = {
  blank: "Blank",
  yourAnswer: "Your answer",
  noAnswer: "Not answered",
  expected: "Expected",
  correct: "Correct",
  incorrect: "Incorrect",
  score: "Score",
  weights: "Weighted blanks",
} as const;

export type ClozeReviewStringKey = keyof typeof clozeReviewStrings;
