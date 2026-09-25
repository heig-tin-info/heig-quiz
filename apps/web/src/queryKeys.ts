/*
 * Every TanStack Query key of the SPA, as one factory per cache family.
 *
 * One module and not a `keys.ts` per feature because the keys CROSS features
 * more often than not: the question editor invalidates the pool, the grading
 * panel invalidates the results, the results screen invalidates the
 * evaluation, the picker of an evaluation reads a pool's questions. A key
 * owned by one feature folder and imported by three others is a shared module
 * in all but name; this is that module, named.
 *
 * Invalidation matches by PREFIX, so the array shapes are load-bearing:
 * `poolKey(id)` must stay a prefix of `poolTagsKey(id)` and
 * `poolQuestionsKey(id, …)`, `gradingKey(id)` of every grading read,
 * `resultsKey(id)` of every results read. `queryKeys.test.ts` pins each
 * factory against the literal it replaced, so a reshaped key fails there and
 * not as a stale screen.
 */

// --- Session and application -------------------------------------------------

export const configKey = ["config"] as const;
export const meKey = ["me"] as const;
export const notificationsKey = ["notifications"] as const;
export const adminTeachersKey = ["admin-teachers"] as const;
/** The caller's personal API tokens (settings). */
export const apiTokensKey = ["api-tokens"] as const;
/** The assistants connected through OAuth (settings, ADR-023). */
export const connectionsKey = ["oauth-connections"] as const;
/** One pending OAuth request, on the consent page. */
export const oauthRequestKey = (id: string) => ["oauth-request", id] as const;

// --- Courses and classrooms --------------------------------------------------

export const coursesKey = ["courses"] as const;
export const courseKey = (id: string) => ["course", id] as const;
/** `null` while the id is not known yet: the query is disabled, the key still well-formed. */
export const classroomKey = (id: string | null) => ["classroom", id] as const;

// --- Pools and questions -----------------------------------------------------

export const poolsKey = ["pools"] as const;
/** An admin's `?scope=all` list: under `poolsKey`, so every invalidation of it reaches this one too. */
export const allPoolsKey = ["pools", "all"] as const;
/** The pools an evaluation's picker offers: under `poolsKey`, for the same reason. */
export const evaluationPoolsKey = (id: string) => ["pools", "evaluation", id] as const;
/** The prefix of EVERY pool's cache — details, questions, tags — for a move across pools. */
export const anyPoolKey = ["pool"] as const;
/** `undefined` while the id is not known yet (a question editor before its detail loads). */
export const poolKey = (id: string | undefined) => ["pool", id] as const;
/**
 * `GET /pools/:id/questions`, keyed by the query string `questionQuery`
 * (`pool/filters.ts`) builds for the first page. Under the pool's own key, so
 * everything that invalidates the pool — a question created, moved,
 * duplicated or deleted — refreshes every list of its questions, the
 * evaluation's picker included.
 */
export const poolQuestionsKey = (poolId: string, search: string) =>
  ["pool", poolId, "questions", search] as const;
export const poolTagsKey = (poolId: string) => ["pool", poolId, "tags"] as const;
/** `GET /pools/:id/categories`, the tree with its counts: under the pool, like the tags. */
export const poolCategoriesKey = (poolId: string) => ["pool", poolId, "categories"] as const;
export const poolMembersKey = (poolId: string) => ["pool-members", poolId] as const;
/** Without `q`, the prefix of every search of that pool's candidates. */
export function poolCandidatesKey(poolId: string): readonly ["pool-candidates", string];
export function poolCandidatesKey(
  poolId: string,
  q: string,
): readonly ["pool-candidates", string, string];
export function poolCandidatesKey(poolId: string, q?: string) {
  return q === undefined
    ? (["pool-candidates", poolId] as const)
    : (["pool-candidates", poolId, q] as const);
}

export const questionKey = (id: string) => ["question", id] as const;
/** `POST /questions/:id/preview` of the draft or of one published version. */
export const questionPreviewKey = (id: string, source: "draft" | number | undefined) =>
  ["question", id, "preview", source] as const;

// --- Evaluations ---------------------------------------------------------------

export const evaluationsKey = (classroomId: string) => ["evaluations", classroomId] as const;
export const evaluationKey = (id: string) => ["evaluation", id] as const;
/**
 * Both toggles are in the key because both are in the REQUEST: the answers
 * travel only with `?includeAnswers=1`, and the live verdicts of ADR-020 are
 * computed only with `?results=1`. A cached variant of one is not the other.
 */
export const dashboardKey = (id: string, includeAnswers: boolean, includeResults = false) =>
  ["dashboard", id, includeAnswers, includeResults] as const;
export const attemptInspectKey = (evaluationId: string, attemptId: string | null) =>
  ["attempt-inspect", evaluationId, attemptId] as const;
/** Every student paper cached for one evaluation, for a blanket invalidation. */
export const attemptInspectPrefix = (evaluationId: string) =>
  ["attempt-inspect", evaluationId] as const;

// --- Grading and results -------------------------------------------------------

/** The prefix of every grading read of one evaluation. */
export const gradingKey = (evaluationId: string) => ["grading", evaluationId] as const;
/** The steps of a traversal and their state. `anonymous` is the `"0"`/`"1"` the request carries. */
export const gradingStepsKey = (evaluationId: string, order: string, anonymous: string) =>
  ["grading", evaluationId, "steps", order, anonymous] as const;
export const gradingQueueKey = (
  evaluationId: string,
  scope: string | null,
  state: string,
  anonymous: string,
) => ["grading", evaluationId, "queue", scope, state, anonymous] as const;
export const gradingProgressKey = (evaluationId: string) =>
  ["grading", evaluationId, "progress"] as const;
/** The published versions a regrade of one item may target (issue #106). */
export const gradingItemVersionsKey = (evaluationId: string, itemId: string) =>
  ["grading", evaluationId, "versions", itemId] as const;

/** The prefix of every results read of one evaluation. */
export const resultsKey = (evaluationId: string) => ["results", evaluationId] as const;
export const resultsViewKey = (evaluationId: string) => ["results", evaluationId, "view"] as const;
export const resultsByQuestionKey = (evaluationId: string) =>
  ["results", evaluationId, "by-question"] as const;

// --- Students ------------------------------------------------------------------

export const studentHomeKey = ["student", "home"] as const;
export const studentClassroomsKey = ["student", "classrooms"] as const;
export const attemptKey = (attemptId: string) => ["attempt", attemptId] as const;
export const attemptFeedbackKey = (attemptId: string) =>
  ["attempt", attemptId, "feedback"] as const;
/** The `POST …/take` behind the attempt route, per access code sent (`null`: none yet). */
export const attemptEntryKey = (evaluationId: string, accessCode: string | null) =>
  ["attempt", "enter", evaluationId, accessCode] as const;

// --- Polls ---------------------------------------------------------------------

export const pollQuestionsKey = ["poll-questions"] as const;
export const pollKey = (id: string) => ["poll", id] as const;
export const publicPollKey = (code: string) => ["poll", "public", code] as const;
