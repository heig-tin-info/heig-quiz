/**
 * English defaults for the `short` components; `apps/web` passes its French
 * entries through the `strings` prop (see `StringOverrides` in
 * `@quiz/core/client`).
 */

export const shortEditorStrings = {
  prompt: "Statement",
  preview: "Preview",
  kind: "Expected answer",
  kindText: "Text",
  kindNumber: "Number",
  kindDate: "Date",
  kindTime: "Time",
  placeholder: "Placeholder",
  minLength: "Min length",
  maxLength: "Max length",
  min: "Min",
  max: "Max",
  integer: "Integer",
  from: "From",
  to: "To",
  prefilters: "Prefilters",
  prefiltersHint:
    "Applied to the student's answer and to every accepted text before matching.",
  prefilterTrim: "Trim",
  prefilterLowercase: "Lowercase",
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
  tolerance: "Tolerance",
  tolerancePercent: "Tolerance (%)",
  toleranceMode: "Mode",
  toleranceAbs: "Absolute",
  toleranceRel: "Relative (%)",
  toleranceDays: "Tolerance (days)",
  toleranceMinutes: "Tolerance (minutes)",
  unit: "Unit",
  unitRequired: "Unit required",
  rubric: "Rubric",
  points: "Points",
  pointsHint: "Share of the item, 0 to 1",
  explainNumberExact: "Accepts exactly {value}{unit}.",
  explainNumberAbs: "Accepts {value} ± {tolerance}{unit}.",
  explainNumberRel: "Accepts {value}{unit} ± {tolerance} %, from {min} to {max}.",
  explainUnitRequired: "The unit {unit} is required.",
  explainUnitOptional: "The unit {unit} may be omitted.",
  explainDateExact: "Accepts {value} only.",
  explainDateRange: "Accepts {from} to {to} ({value} ± {n} days).",
  "explainDateRange.one": "Accepts {from} to {to} ({value} ± 1 day).",
  explainTimeExact: "Accepts {value} only.",
  explainTimeRange: "Accepts {from} to {to} ({value} ± {n} minutes).",
  "explainTimeRange.one": "Accepts {from} to {to} ({value} ± 1 minute).",
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
