/**
 * The `grading` module's business layer (PLAN-MVP §4.5 and §5.4).
 *
 * The invariants this file exists to hold:
 *
 *   - ONE writer. Every grading, whoever produced it — the job, a teacher
 *     validating a proposal, a manual override, a regrade — goes through
 *     {@link writeGrading}, which supersedes the previous one and links to it
 *     in a single transaction. The partial unique index of `db/grading.ts`
 *     makes a concurrent double-write fail loudly rather than silently
 *     producing two grades for one answer;
 *   - a manual override always wins and always carries a comment (F-GRADE-05);
 *   - nothing here reads the wall clock: `now` is always the caller's, which
 *     took it from `app.clock` (invariant 5);
 *   - a student payload is still only ever produced by
 *     `modules/live/studentView.ts` (invariant 4), including in the panel.
 *
 * This file is the module's entry for other modules: the code lives in
 * `records.ts` (row type, refusals, cell keys), `writer.ts` (the single
 * writer), `reads.ts` (the grid's reads), `panel.ts` (F-GRADE-03),
 * `teacherWrites.ts` (overrides and validations), `regrade.ts`
 * (F-GRADE-06), `counting.ts` (ADR-108), `kept.ts` (ADR-025) and
 * `partialRetake.ts` (ADR-091). Files of the module import each other
 * directly, never through this one.
 */
export {
  GradingError,
  pairKey,
  type GradingRecord,
  type PairKey,
} from "./records.js";
export {
  writeGrading,
  writeGradings,
  type WriteGradingInput,
  type WriteGuard,
} from "./writer.js";
export {
  cellOfAnswer,
  pointsByAttempt,
  progressOf,
  standingGradings,
  toGrading,
  validatedGradings,
  verdictOf,
} from "./reads.js";
export { expectedViews, exportsText, gradingQueue, gradingSteps, historyOfCell } from "./panel.js";
export {
  assertPointsInRange,
  batchValidate,
  criteriaOf,
  manualOverride,
  standDownAutomaticGradings,
  validateGrading,
} from "./teacherWrites.js";
export { checkLlmRegradeBudget, pointsAcrossRegrade, regradeItem, RegradeAudit } from "./regrade.js";
export { changeItemCounting, type CountingChange } from "./counting.js";
// The kept attempt of each student (F-EVAL-15, ADR-025), in `./kept.ts`.
export {
  keptAttempts,
  scoreOf,
  studentAttempts,
  tallyByAttempt,
  type AttemptTally,
  type StudentAttempts,
} from "./kept.js";

export { copyGradings, standingsOf, validatedOfAttempt } from "./partialRetake.js";
