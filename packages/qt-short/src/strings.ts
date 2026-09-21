/**
 * English defaults for the `short` components; `apps/web` passes its French
 * entries through the `strings` prop (see `StringOverrides` in
 * `@quiz/core/client`).
 */

export const shortEditorStrings = {
  prompt: "Statement",
  promptHint: "The students see it as written.",
  preview: "Preview",
  kind: "Expected answer",
  kindText: "Text",
  kindNumber: "Number",
  kindDate: "Date",
  kindTime: "Time",
  placeholder: "Placeholder",
  placeholderHint: "Shown in the empty field. Never part of the answer.",
  matchers: "Accepted answers",
  matchersHint: "Evaluated in order; the first match wins.",
  matcherKind: "Matcher",
  matcherExact: "Exact text",
  matcherRegex: "Regular expression",
  matcherNumber: "Number",
  matcherDate: "Date",
  matcherTime: "Time",
  matcherLlm: "LLM rubric (phase 2)",
  value: "Value",
  pattern: "Pattern",
  flags: "Flags",
  caseSensitive: "Case sensitive",
  tolerance: "Tolerance",
  toleranceAbs: "Absolute",
  toleranceRel: "Relative (%)",
  toleranceDays: "Tolerance (days)",
  toleranceMinutes: "Tolerance (minutes)",
  unit: "Unit",
  unitRequired: "Unit required",
  rubric: "Rubric",
  points: "Points",
  pointsHint: "Share of the item awarded by this matcher.",
  addMatcher: "Add an accepted answer",
  removeMatcher: "Remove accepted answer",
  llmWarning: "An LLM matcher cannot be published yet.",
} as const;

export type ShortEditorStringKey = keyof typeof shortEditorStrings;

export const shortPlayerStrings = {
  label: "Your answer",
  hintText: "Type your answer.",
  hintNumber: "Type a number; a comma or a dot both work.",
  hintDate: "Type a date, for instance 2026-09-20.",
  hintTime: "Type a time, for instance 14:05.",
} as const;

export type ShortPlayerStringKey = keyof typeof shortPlayerStrings;

export const shortReviewStrings = {
  yourAnswer: "Your answer",
  noAnswer: "No answer",
  accepted: "Accepted",
  rejected: "Not accepted",
  partially: "Partially accepted",
  expected: "Accepted answers",
  matchedBy: "Matched by",
  score: "Score",
} as const;

export type ShortReviewStringKey = keyof typeof shortReviewStrings;
