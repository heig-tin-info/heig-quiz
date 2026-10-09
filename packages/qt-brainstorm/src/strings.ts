/**
 * English defaults for the `brainstorm` components; `apps/web` passes its
 * French entries through the `strings` prop.
 */

export const brainstormEditorStrings = {
  prompt: "Question",
  maxIdeas: "Ideas per participant",
  maxIdeasHint: "Each idea is a few words; the room sees them as bubbles.",
} as const;

export type BrainstormEditorStringKey = keyof typeof brainstormEditorStrings;

export const brainstormPlayerStrings = {
  label: "Your idea",
  list: "Your ideas",
  placeholder: "A few words",
  add: "Add",
  remove: "Remove",
  hint: "One idea at a time, a few words each. You can add up to {max}.",
  full: "You have added {max} ideas. Remove one to add another.",
} as const;

export type BrainstormPlayerStringKey = keyof typeof brainstormPlayerStrings;

export const brainstormReviewStrings = {
  yourIdeas: "Your ideas",
  none: "No ideas",
} as const;

export type BrainstormReviewStringKey = keyof typeof brainstormReviewStrings;

export const brainstormGradingStrings = {
  ideas: "Ideas",
  empty: "empty",
} as const;
