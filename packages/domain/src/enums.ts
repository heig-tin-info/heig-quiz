/**
 * Lists of names that no rule of this package owns but that more than one
 * layer spells: the contracts derive their `z.enum` from them and the
 * Drizzle schema its `text` columns. A list a rule owns lives beside that
 * rule (`EVALUATION_STATES` in `itemList.ts`, `POOL_ROLES` in `poolRole.ts`…).
 */

/** The interface languages (N-I18N-01): the dictionaries, the account preference, the mails. */
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

/** Who produced a grading. `llm` is only ever `proposed`. */
export const GRADING_SOURCES = ["auto", "llm", "manual"] as const;
export type GradingSourceName = (typeof GRADING_SOURCES)[number];

/**
 * `validated` counts towards the grade; `proposed` waits for the teacher;
 * `superseded` is history.
 */
export const GRADING_STATES = ["proposed", "validated", "superseded"] as const;
export type GradingStateName = (typeof GRADING_STATES)[number];
