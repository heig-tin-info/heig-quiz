/**
 * The English defaults of every string the `mcq` components render.
 *
 * A component takes a partial override through its `strings` prop
 * (`StringOverrides` in `@quiz/core/client`), so `apps/web` passes the French
 * entries of its own `i18n.tsx` (N-I18N-01) and this package never imports the
 * app. The key set is typed: a renamed key breaks the host at compile time.
 */

export const mcqEditorStrings = {
  prompt: "Statement",
  promptHint: "Markdown. The students see it as written.",
  preview: "Preview",
  choices: "Choices",
  choicesHint: "Tick the correct answers. The order is shuffled per student.",
  choiceText: "Text of choice",
  correct: "Correct",
  addChoice: "Add a choice",
  removeChoice: "Remove choice",
  moveUp: "Move up",
  moveDown: "Move down",
  scoring: "Scoring",
  mode: "Answers",
  modeSingle: "One answer",
  modeMultiple: "Several answers",
  policy: "Policy",
  policyAllOrNothing: "All or nothing",
  policyPartial: "Partial",
  policyPenalized: "Penalized",
  penalty: "Penalty factor",
  penaltyHint: "Share of a wrong choice removed from the score.",
  allowNegative: "Allow a negative score",
  maxSelections: "Maximum selections",
  maxSelectionsHint: "Empty means no limit.",
  shuffleChoices: "Shuffle the choices",
} as const;

export type McqEditorStringKey = keyof typeof mcqEditorStrings;

export const mcqPlayerStrings = {
  chooseOne: "Choose one answer.",
  chooseSeveral: "Choose every correct answer.",
  chooseUpTo: "Choose at most the allowed number of answers.",
  limitReached: "You have reached the maximum number of selections.",
} as const;

export type McqPlayerStringKey = keyof typeof mcqPlayerStrings;

export const mcqReviewStrings = {
  yourAnswer: "Your answer",
  noAnswer: "No answer",
  correct: "Correct",
  incorrect: "Incorrect",
  missed: "Missed",
  chosen: "Chosen",
  score: "Score",
  breakdown: "Correct choices ticked",
  wrongTicked: "Wrong choices ticked",
  truncated: "Extra selections were dropped by the answer limit.",
} as const;

export type McqReviewStringKey = keyof typeof mcqReviewStrings;

export const mcqStatsStrings = {
  title: "Answer distribution",
  noAnswers: "No answer yet.",
  respondents: "answers",
} as const;

export type McqStatsStringKey = keyof typeof mcqStatsStrings;
