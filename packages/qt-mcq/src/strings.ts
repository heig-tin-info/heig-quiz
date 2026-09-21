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
  promptHint: "The students see it as written.",
  choices: "Choices",
  choicesHint: "Tick the correct answers. The order is shuffled per student.",
  choiceText: "Text of choice",
  correct: "Correct",
  addChoice: "Add a choice",
  removeChoice: "Remove choice",
  /** Accessible name of the drag handle; the keyboard reorders through it too. */
  reorderChoice: "Reorder choice",
  /** Enter walks to the next choice; shown in the app's shortcut strip. */
  nextChoice: "Next choice",
  scoring: "Scoring",
  policy: "Scoring policy",
  /** Accessible name of the "?" beside the policy label. */
  policyHelp: "About the scoring policies",
  /*
   * The six values of `McqQuestionPolicy`, and one line each for what they do
   * to a score. The order is the order of the <select>: the default first,
   * then from the strictest to the most forgiving.
   */
  policyInherit: "Inherited from the evaluation",
  policyAllOrNothing: "All or nothing",
  policyTrueFalse: "True/false per choice",
  policyDiscordance: "Discordances",
  policySymmetric: "Symmetric",
  policyRipkey: "Ripkey",
  policyDescInherit: "Uses the policy set on the evaluation.",
  policyDescAllOrNothing: "The exact set of correct choices, or nothing.",
  policyDescTrueFalse: "Each choice is a true/false item; the share answered right.",
  policyDescDiscordance: "By distance to the key: 0 → 1, 1 → 0.5, 2 → 0.2, more → 0.",
  policyDescSymmetric: "+1/C per correct tick, −1/W per wrong tick, floored at 0.",
  policyDescRipkey: "The share of correct ticks, cancelled by any wrong tick.",
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
