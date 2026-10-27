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
  criteria: "Criteria",
  criteriaCount: "{n} criteria",
  "criteriaCount.one": "1 criterion",
  addCriterion: "Add a criterion",
  criteriaHint: "Each criterion is scored from 0 to its weight. The question's points are shared out by weight.",
  criterionTitle: "Criterion",
  criterionTitleAria: "Criterion {n}",
  criterionWeight: "Weight",
  criterionWeightAria: "Weight of criterion {n}",
  criterionPrompt: "Grading prompt",
  criterionPromptAria: "Grading prompt of criterion {n}",
  criterionPromptPlaceholder: "What the answer must say to earn the weight, and what earns part of it",
  generatePrompt: "Generate the prompt",
  generatePromptAria: "Generate the prompt of criterion {n}",
  removeCriterion: "Remove criterion {n}",
  rubric: "Grading instructions",
  rubricHint: "The answer is graded as one block. Criteria score each point apart.",
  convertRubric: "Convert to criteria",
  globalRubric: "Global instructions (optional)",
  globalRubricField: "Global instructions",
  globalRubricHint: "Read with every criterion, such as \"ignore spelling\".",
  defaultPoints: "Default points: {n}",
  defaultPointsHint: "The evaluation sets each question's points.",
  reference: "Model answer",
  referenceHint: "Optional. Shown to the grader beside every answer, and to students when the evaluation shows the expected answer.",
  manualGrading:
    "Graded by hand: every written answer reaches the grading panel as a proposal of 0 points, to settle.",
  decimal: ".",
} as const;

export type RichEditorStringKey = keyof typeof richEditorStrings;

export const richPlayerStrings = {
  label: "Your answer",
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
  rubric: "Grading instructions",
  noRubric: "No grading instructions.",
  criteria: "Criteria",
  weight: "Weight {n}",
  byCriterion: "Points per criterion",
  reference: "Model answer",
  score: "Score",
} as const;

export type RichReviewStringKey = keyof typeof richReviewStrings;

/** The words of the debrief's answer key (`Key`, ADR-109). */
export const richKeyStrings = {
  modelAnswer: "Model answer",
} as const;

export type RichKeyStringKey = keyof typeof richKeyStrings;

/** The words of the grading table's one essay column (ADR-044). */
export const richGradingStrings = {
  essay: "Essay",
} as const;
