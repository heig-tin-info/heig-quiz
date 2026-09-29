/**
 * English defaults for the `rich` components; `apps/web` passes its French
 * entries through the `strings` prop (see `StringOverrides` in
 * `@quiz/core/client`).
 *
 * `decimal` is the one entry that is not a sentence: the separator of an A4
 * page count ("1.5" / « 1,5 »), which the package formats without knowing the
 * reader's language.
 */

export const richEditorStrings = {
  prompt: "Statement",
  format: "Answer field",
  formatMarkdown: "Formatted text",
  formatPlain: "Plain text",
  formatHint:
    "Formatted text gives the student a toolbar: bold, lists, code, formulas. Plain text is a bare field.",
  maxChars: "Character limit",
  maxCharsHint: "Empty: up to {cap} characters. About {perPage} characters fill an A4 page.",
  maxCharsPages: "About {pages} A4 page(s).",
  rubric: "Grading criteria",
  rubricHint: "How you will award the points, for yourself or another grader: shown beside every answer in the grading panel. Example: \"2 pts: names the complexity. 1 pt: gives an example.\" Students never see it.",
  reference: "Model answer",
  referenceHint: "Optional. Shown to the grader beside every answer, and to students when the evaluation shows the expected answer.",
  manualGrading:
    "Graded by hand: every written answer reaches the grading panel as a proposal of 0 points, to settle.",
  decimal: ".",
} as const;

export type RichEditorStringKey = keyof typeof richEditorStrings;

export const richPlayerStrings = {
  label: "Your answer",
  placeholder: "Write your answer here.",
  count: "{count} characters",
  countOf: "{count} / {max} characters",
  pages: "about {pages} A4 page(s)",
  over: "{n} characters over the limit. Shorten your answer: nothing is saved until it fits.",
  decimal: ".",
} as const;

export type RichPlayerStringKey = keyof typeof richPlayerStrings;

export const richReviewStrings = {
  answer: "Answer",
  noAnswer: "No answer",
  count: "{count} characters",
  rubric: "Grading criteria",
  noRubric: "No grading criteria.",
  reference: "Model answer",
  score: "Score",
} as const;

export type RichReviewStringKey = keyof typeof richReviewStrings;

/** The words of the grading table's one essay column (ADR-040). */
export const richGradingStrings = {
  essay: "Essay",
} as const;

export type RichGradingStringKey = keyof typeof richGradingStrings;
