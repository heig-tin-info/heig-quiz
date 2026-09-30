/**
 * The `evaluation` module's business layer (PLAN-MVP §3.3, §4.3, §5.1).
 *
 * This file is the entry other modules import; the code lives in cohesive
 * files beside it:
 *   - `shared.ts`: the row types, `DbOrTx`, the failures and
 *     `assertItemListEditable`;
 *   - `stateMachine.ts`: the transition table, its guards and `applyState`;
 *   - `reads.ts`: the settings accessors, the item and roster reads, the
 *     detail and the list;
 *   - `writes.ts`: create, patch, delete, and the narrow writers the other
 *     modules call;
 *   - `items.ts`: the item list, the pools it draws from, and the copy;
 *   - `activities.ts`: the Activities section, across classrooms (#190);
 *   - `announce.ts`: what an exercise's students are told when it is
 *     scheduled or starts running (ADR-030 §c).
 *
 * Three rules shape this layer:
 *   - an item freezes ONE published question version at the moment it is
 *     added (F-EVAL-03); the only way to move it is `updateVersions`, and
 *     that door closes as soon as an attempt exists;
 *   - the item list itself (add, remove, reorder, points, milestones,
 *     versions) is editable only in `draft` and `scheduled` with no attempt,
 *     the rule `@quiz/domain/itemList` owns and `assertItemListEditable`
 *     applies (issue #79);
 *   - the state machine is a table, not a pile of `if`s: `TRANSITIONS`
 *     says what is legal and `guardTransition` says why an otherwise
 *     legal move is refused. The operational half (start, pause, close) is in
 *     `modules/live/service.ts`, which calls back into `applyState` here;
 *   - a structural change is refused once an attempt exists, because the
 *     wording, the order and the scale a student saw can never move under
 *     them; and while the evaluation runs, the whole configuration is locked
 *     but for the title, the access control and the feedback policy (#86,
 *     `configLock`).
 */
export type { EvaluationRecord, DbOrTx } from "./shared.js";
export { EvaluationError, IllegalTransition, Locked, assertItemListEditable } from "./shared.js";
export {
  isLegalTransition,
  guardTransition,
  assertReady,
  pastTimingOf,
  tryApplyState,
  applyState,
  transition,
} from "./stateMachine.js";
export type { JoinedItem } from "./reads.js";
export { listActivities } from "./activities.js";
export { announceMove } from "./announce.js";
export {
  seatsOf,
  classroomIdOf,
  settingsOf,
  retakePolicyOf,
  retakesEnabled,
  isLatestAttempt,
  isStaffAttempt,
  feedbackOf,
  scaleOf,
  toEvaluation,
  templateRevisionsOf,
  gradeDefaults,
  negativeMarkingEnabled,
  trustedClients,
  drillAllowed,
  attemptCount,
  joinedItems,
  joinedItem,
  studentEvaluationRows,
  totalPointsByEvaluation,
  itemCountsByEvaluation,
  itemRows,
  itemRowsOf,
  staleOf,
  staffAttemptIds,
  staffRosterWithAttempt,
  editableQuestionIdsOf,
  evaluationDetail,
  listEvaluations,
  byId,
} from "./reads.js";
export {
  createEvaluation,
  createPollEvaluation,
  patchEvaluation,
  deleteEvaluation,
  extendClosesAt,
  setPollSettings,
  setRelease,
  clearRelease,
  setCorrectionPublished,
  cachedGrade,
  cachedGrades,
  type CachedGrade,
  setModifiedAfterRelease,
  flagReleasedEvaluationsOf,
  claimGradingReady,
  clearGradingReady,
  retargetItemVersion,
  setAllowDrill,
  AllowDrillLocked,
} from "./writes.js";
export {
  coursePoolIds,
  inLinkedPool,
  listCoursePools,
  addItems,
  patchItem,
  deleteItem,
  reorderItems,
  updateVersions,
  itemRef,
  deprecatedRefs,
  unlinkedRefs,
  assertPoolsLinked,
  replaceItems,
  copyItems,
  copyEvaluation,
} from "./items.js";
