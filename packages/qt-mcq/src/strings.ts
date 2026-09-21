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
  choices: "Choices",
  choicesHint: "Tick the correct answers.",
  choiceText: "Text of choice",
  /**
   * The accessible name of the LETTER, which is the correct/incorrect toggle
   * itself. `{letter}` is filled in by the row; a whole sentence and not a
   * label plus a letter, because the two halves do not fall in the same order
   * in every language.
   */
  correctChoice: "Choice {letter} is correct",
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
   * to a score. The order is the order of the segmented control: the default
   * first, then from the strictest to the most forgiving.
   *
   * The LABELS are one word wherever one word will do — they are pills in a
   * 288 px column now, not rows of a list, and the sentence that explained
   * each one is the description under the control and the help topic behind
   * the "?". The same six words name the policy on the settings page and in
   * an evaluation's options, so a teacher meets one vocabulary.
   */
  policyInherit: "Inherited",
  policyAllOrNothing: "Exact",
  policyTrueFalse: "True/false",
  policyDiscordance: "Distance",
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
  /**
   * The cap refused by `mcq.max_below_correct`, said by the editor ITSELF.
   *
   * The rule is in the schema and the server repeats it on every save, but a
   * teacher who types 2 under three ticked answers must be told at the
   * keystroke, not 500 ms later once an autosave came back. The host maps
   * this key onto the very sentence it already shows for the server's issue,
   * so the two never disagree.
   */
  maxBelowCorrect: "The maximum number of selections is below the number of correct choices.",
  /**
   * Shuffling is ON unless a question opts out: the evaluation decides, and
   * a question whose choices must keep their order ("all of the above") says
   * so once. The stored flag is the opposite (`shuffleChoices`), because that
   * is what the grader and `toStudent` read.
   */
  neverShuffle: "Never shuffle this question",
  neverShuffleHint: "Even when the evaluation shuffles choices.",
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
