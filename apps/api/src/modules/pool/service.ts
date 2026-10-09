/**
 * The `pool` module's business layer: pools, categories, questions, their
 * versions. Routes call this file; no other module reads it except through
 * the few functions the plan lets them (`setCoursePools`, `poolsOfCourse`).
 *
 * This file is the entry other modules import; the code lives in cohesive
 * files beside it:
 *   - `shared.ts`: the row types, the errors of a question write, the
 *     category guard and `qualified`;
 *   - `pools.ts`: the pools themselves, and the detail of one;
 *   - `members.ts`: the people of a pool (F-POOL-05);
 *   - `coursePools.ts`: `course_pools`, called by the `org` module;
 *   - `categories.ts`: the category tree;
 *   - `questionList.ts`: listing and searching questions, their JSON views;
 *   - `questionWrite.ts`: the write path of a question and its versions;
 *   - `move.ts`: moving questions between pools (ADR-017);
 *   - `instance.ts`: the instances of a parameterized question (ADR-056),
 *     which every reader of a version for an attempt goes through.
 *
 * Two rules shape everything here:
 *   - a stored config is only ever read and written through `./config.ts`
 *     (PLAN-MVP §1.6), never parsed inline;
 *   - a question's content lives in `question_versions`, never in
 *     `questions`; publishing is ONE transaction guarded by two unique
 *     indexes (see `db/pool.ts`).
 */
export type { PoolRow, QuestionRecord } from "./shared.js";
export {
  asStatic,
  isParameterized,
  loadConfig,
  typeOf,
  type StaticVersion,
  type StoredVersion,
} from "./config.js";
export {
  configPerAttempt,
  exampleConfig,
  exampleInstance,
  explanationOrNull,
  instanceOf,
  InstanceMismatch,
  itemInstance,
  parameterIssues,
  parametersOf,
  readingPerAttempt,
  templateHash,
  writtenConfig,
  type Instance,
  type InstanceAttempt,
  type Reading,
  type VersionContent,
} from "./instance.js";
export {
  DraftInvalid,
  MissingDraft,
  VersionInUse,
  CategoryNotInPool,
  isCategoryOf,
} from "./shared.js";
export {
  listPools,
  poolRolesOf,
  createPool,
  PERSONAL_POOL_NAME,
  ensurePersonalPool,
  updatePool,
  poolUses,
  deletePool,
  poolDetail,
} from "./pools.js";
export {
  listMembers,
  findTeacherByEmail,
  findTeacherById,
  listCandidates,
  isMemberOrOwner,
  addMember,
  setMemberRole,
  removeMember,
  poolAudience,
  transferOnLoss,
  vacateSeats,
} from "./members.js";
export { mayLinkPool, poolsOfCourse, setCoursePools } from "./coursePools.js";
export {
  categoryTree,
  categoriesWithCounts,
  createCategory,
  wouldCycle,
  updateCategory,
  checkCategoryLayout,
  reorderCategories,
  deleteCategory,
} from "./categories.js";
export {
  InvalidCursor,
  listQuestions,
  rankReachableQuestions,
  searchReachableQuestions,
} from "./questionList.js";
export { clearPoolStars, starQuestions, unstarQuestions } from "./stars.js";
export {
  createQuestion,
  createUnsavedQuestion,
  keepUnsavedQuestion,
  draftOf,
  questionDetail,
  patchQuestion,
  putDraft,
  publishQuestion,
  assetReachableBy,
  versionDetail,
  versionRow,
  listVersions,
  restoreVersion,
  deprecateVersion,
  resetQuestionStats,
  softDeleteQuestion,
  hardDeleteQuestion,
  copyQuestion,
  type QuestionWriter,
} from "./questionWrite.js";
export type { UsingCourse } from "./move.js";
export {
  MoveNameTaken,
  coursesUsingQuestions,
  coursesLinkedToPool,
  staffSeatsOf,
  moveQuestions,
} from "./move.js";
