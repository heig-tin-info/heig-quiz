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

// --- Projects (F-PROJ) ------------------------------------------------------

/** F-PROJ-03: `draft` → `published` → `locked` (at the deadline). */
export const PROJECT_STATES = ["draft", "published", "locked"] as const;
export type ProjectStateName = (typeof PROJECT_STATES)[number];

/** F-PROJ-09: a ruleset that blocks pushes, or one empty commit of the App per branch. */
export const DEADLINE_STRATEGIES = ["lock", "commit"] as const;
export type DeadlineStrategyName = (typeof DEADLINE_STRATEGIES)[number];

/** F-PROJ-01: `none` — no score shown and no review dispatched. */
export const PROJECT_GRADING_MODES = ["auto", "none"] as const;
export type ProjectGradingModeName = (typeof PROJECT_GRADING_MODES)[number];

/** F-PROJ-03: publish by hand (now), or by the ticker at the start. */
export const PUBLISH_MODES = ["manual", "scheduled"] as const;
export type PublishModeName = (typeof PUBLISH_MODES)[number];

/** Pass / fail of a repository without `grading.yml` (F-PROJ-10), as the webhooks store it and a student reads it. */
export const CI_STATUSES = ["none", "pending", "pass", "fail"] as const;
export type CiStatusName = (typeof CI_STATUSES)[number];

/**
 * Why a grade run has a score or none (F-PROJ-10, `extractScore`):
 * `multiple` — several `GRADE` annotations, no score.
 */
export const GRADE_RUN_PARSE_STATUSES = ["ok", "no_annotation", "malformed", "multiple", "fallback"] as const;
export type GradeRunParseStatusName = (typeof GRADE_RUN_PARSE_STATUSES)[number];

/**
 * What triggered a grade run: a push (`ci`, the indicative score) or the
 * final review dispatched after the freeze (`review`, heig-classroom's
 * `llm`; the import maps it). A `review` run never enters the selection of
 * the current score: it fills the repository's review slot (F-PROJ-11).
 */
export const GRADE_RUN_KINDS = ["ci", "review"] as const;
export type GradeRunKindName = (typeof GRADE_RUN_KINDS)[number];
