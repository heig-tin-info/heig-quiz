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
/** The kinds x channels grid, the address and the Teams link (settings, ADR-030). */
export const notificationSettingsKey = ["notification-settings"] as const;
export const adminTeachersKey = ["admin-teachers"] as const;
/**
 * Every account (F-ADMIN-01): under `adminTeachersKey`, so a grant, a revoke
 * and the `admin` and `courses` hints that refresh the teachers refresh the
 * roles and counts of this list too.
 */
export const adminUsersKey = [...adminTeachersKey, "users"] as const;
/**
 * The scheduled tasks (F-ADMIN-06): under `adminTeachersKey` too, so the
 * `admin` hint another administrator's change raises reaches this list.
 */
export const adminTasksKey = [...adminTeachersKey, "tasks"] as const;
/**
 * The LLM gateway's settings and the month's usage (ADR-058): under
 * `adminTeachersKey`, so the `admin` hint of another administrator's save or
 * test refreshes them.
 */
export const adminLlmKey = [...adminTeachersKey, "llm"] as const;
export const adminLlmUsageKey = [...adminTeachersKey, "llm-usage"] as const;
/**
 * The sorting of the existing tags (ADR-081, second addendum): every (pool,
 * tag) pair and its decision. Under `adminTeachersKey`, so another
 * administrator's `admin` hint refreshes it.
 */
export const adminConceptSortingKey = [...adminTeachersKey, "concept-sorting"] as const;
/** The instance's vocabulary of concepts, merged ones left out (ADR-081). */
export const conceptsKey = ["concepts"] as const;
/** The kiosk station registry (ADR-051 §5). */
export const adminKioskKey = ["admin-kiosk-devices"] as const;
/** Whether this browser is a kiosk station: its `quiz_kiosk` cookie, read by the server. */
export const kioskStationKey = ["kiosk-station"] as const;
/** What a station's code names, on the phone (ADR-051 §7): the station and the exams. */
export const pairPreviewKey = (code: string) => ["pair-preview", code] as const;
/**
 * The system status (N-OPS-03, ADR-055): a key of its own, NOT under
 * `adminTeachersKey`, so the `admin` hint of every finished task does not
 * refetch it; it polls on its own clock instead.
 */
export const adminSystemKey = ["admin-system"] as const;
/** Whether the editor's "Generate answers" wand works now, and for which types (ADR-059). */
export const generateAvailabilityKey = ["generate-availability"] as const;
/** The teacher assistant (ADR-080): whether it answers, the caller's conversations and one of them. */
export const assistKey = ["assist"] as const;
export const assistAvailabilityKey = [...assistKey, "availability"] as const;
export const assistConversationsKey = [...assistKey, "conversations"] as const;
export const assistConversationKey = (id: string) => [...assistConversationsKey, id] as const;
/** The caller's personal API tokens (settings). */
export const apiTokensKey = ["api-tokens"] as const;
/** The assistants connected through OAuth (settings, ADR-023). */
export const connectionsKey = ["oauth-connections"] as const;
/** One pending OAuth request, on the consent page. */
export const oauthRequestKey = (id: string) => ["oauth-request", id] as const;
/** One pending Teams link, on the link page (ADR-030). */
export const teamsLinkKey = (token: string) => ["teams-link", token] as const;
/** The HEIG Quiz tab inside Teams: the Teams host, then what the tab endpoint says (ADR-030). */
export const teamsHostKey = ["teams-host"] as const;
export const teamsTabKey = ["teams-tab"] as const;

// --- Courses and classrooms --------------------------------------------------

export const coursesKey = ["courses"] as const;
export const courseKey = (id: string) => ["course", id] as const;
/**
 * `GET /courses/:id/templates` (ADR-031): under the course, so a course
 * refresh reaches it. `null` while the course is not known yet.
 */
export const courseTemplatesKey = (id: string | null) => ["course", id, "templates"] as const;
/** `GET /courses/:id/conditions` (F-ORG-16): the course's whole catalog, archived entries included. */
export const courseConditionsKey = (id: string) => ["course", id, "conditions"] as const;
/** `null` while the id is not known yet: the query is disabled, the key still well-formed. */
export const classroomKey = (id: string | null) => ["classroom", id] as const;
/**
 * The teacher's reads of a classroom's drill (ADR-041 §8): under the
 * classroom, so turning its drill on or off (which invalidates the
 * classroom) refreshes them too. `part` is `activity`, `mastery`, or one
 * student's `progress` (their enrollment id).
 */
export const classroomDrillKey = (id: string, part: string) => ["classroom", id, "drill", part] as const;
/**
 * A classroom's GitHub link and checks (F-GH-02, F-GH-03): under the
 * classroom, so the `classrooms` hint the setup return raises (M2-02) turns
 * the Settings' status green without a reload.
 */
export const classroomGithubKey = (id: string) => ["classroom", id, "github"] as const;
/**
 * `GET /classrooms/:id/projects` (M3-10): the classroom's projects, under the
 * classroom, so the `classrooms` hint that refreshes the classroom reaches
 * them too.
 */
export const classroomProjectsKey = (id: string) => ["classroom", id, "projects"] as const;
/**
 * The organization's repositories a project may hand out, and one of them
 * read in detail (M3-11's form): beside the projects, not under them, so a
 * create's invalidation of the list leaves the picker as it was.
 */
export const projectSourcesKey = (id: string) => ["classroom", id, "project-sources"] as const;
export const projectSourceKey = (id: string, repo: string) => [...projectSourcesKey(id), repo] as const;
/**
 * One project's page (`GET /projects/:id`, M3-12) and what hangs off it — a
 * repository's runs, the review checkpoints — under a root of its own,
 * `project`, which the `projects` hint names (`realtime/hints.ts`): a push
 * or a run on one of its repositories refreshes the page without a reload.
 */
export const projectKey = (id: string) => ["project", id] as const;
export const projectRunsKey = (id: string, rid: string) => [...projectKey(id), "repos", rid, "runs"] as const;
export const projectCheckpointsKey = (id: string) => [...projectKey(id), "checkpoints"] as const;
/** The online workspace of a project (ADR-047, M6-06): its mode and sync, and its open workspaces live from the portal. */
export const projectWorkspaceKey = (id: string) => [...projectKey(id), "workspace"] as const;
export const projectWorkspaceSessionsKey = (id: string) => [...projectWorkspaceKey(id), "sessions"] as const;
/**
 * A classroom's group sets (`GET /classrooms/:id/group-sets`, ADR-070) and
 * one set (`GET /group-sets/:id`, the answer of every write on it), under
 * a root of their own, `group-sets`, which the `groups` hint names
 * (`realtime/hints.ts`): one root reaches the list and every set.
 */
export const groupSetsKey = ["group-sets"] as const;
/** Every classroom's list: what a write of a set marks stale (its counts). */
export const groupSetListsKey = [...groupSetsKey, "classroom"] as const;
export const classroomGroupSetsKey = (classroomId: string) => [...groupSetListsKey, classroomId] as const;
export const groupSetKey = (id: string) => [...groupSetsKey, "set", id] as const;
/**
 * A classroom's gradebook (F-GBOOK, M5-04), under a root of its own,
 * `gradebook`, which the `gradebook` hint names (`realtime/hints.ts`): the
 * staff's table (`GET /classrooms/:id/gradebook`, the answer of every write
 * on it) and the student's own cells
 * (`GET /student/classrooms/:id/gradebook`, a teacher in the student view
 * included). A release, a roster change or an archive raise it too.
 */
export const gradebookRootKey = ["gradebook"] as const;
export const classroomGradebookKey = (classroomId: string) => [...gradebookRootKey, "staff", classroomId] as const;
export const studentGradebookKey = (classroomId: string) => [...gradebookRootKey, "student", classroomId] as const;
/**
 * The organizations Quiz's App is installed on (the connect sheet's picker).
 * Its own root, which the `classrooms` hint names: an installation that
 * completes adds a row while the sheet is open.
 */
export const githubOrgsKey = ["github", "orgs"] as const;
/** The caller's GitHub account link (F-GH-05): under `meKey`, refreshed with the session. */
export const meGithubKey = ["me", "github"] as const;
/** Both payloads of a classroom's journal: what a create, a use or a removal invalidates. */
export const journalRootKey = (id: string) => ["journal", id] as const;
/**
 * A classroom's journal (F-JRN-07), in the payload `view` asks for: the staff
 * one or the student one (a teacher in the student view reads the latter).
 * Its pages hang under it, so one invalidation of the journal (a refresh, the
 * SSE hint of an ingestion) refreshes the navigation and every page read.
 */
export const journalKey = (id: string, view: "staff" | "student") => [...journalRootKey(id), view] as const;
export const journalPageKey = (id: string, view: "staff" | "student", path: string) =>
  [...journalKey(id, view), "page", path] as const;
/** A Quiz-mode page's revisions, and the deleted pages (ADR-057): staff only, under the staff journal. */
export const journalRevisionsKey = (id: string, path: string) => [...journalKey(id, "staff"), "revisions", path] as const;
export const journalDeletedKey = (id: string) => [...journalKey(id, "staff"), "deleted"] as const;
/** One revision with its markdown (it never changes), and that markdown rendered as its page would read. */
export const journalRevisionKey = (id: string, revisionId: string) =>
  [...journalKey(id, "staff"), "revision", revisionId] as const;
export const journalRevisionRenderedKey = (id: string, revisionId: string) =>
  [...journalRevisionKey(id, revisionId), "rendered"] as const;

// --- Pools and questions -----------------------------------------------------

export const poolsKey = ["pools"] as const;
/** The pools an evaluation's picker offers: under `poolsKey`, for the same reason. */
export const evaluationPoolsKey = (id: string) => ["pools", "evaluation", id] as const;
/** The pools a template's picker offers (its course's linked pools), likewise. */
export const templatePoolsKey = (id: string) => ["pools", "template", id] as const;
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
/**
 * Every list of a pool's questions, whatever its search: the prefix a star
 * patches in place (F-POOL-10), rather than refetching every page it holds.
 */
export const poolQuestionListsKey = (poolId: string) => ["pool", poolId, "questions"] as const;
/** The pool's "LLM review" tab (ADR-060): under the pool's key, so its hint refreshes it. */
export const poolReviewsKey = (poolId: string) => ["pool", poolId, "reviews"] as const;
/**
 * The caller's favourites of a pool (`?starred=1`, F-POOL-10): one query for
 * the pool screen's "Clear favourites" count and the picker's section. Under
 * the pool, so whatever refreshes the pool refreshes it too.
 */
export const poolStarredKey = (poolId: string) => ["pool", poolId, "starred"] as const;
export const poolTagsKey = (poolId: string) => ["pool", poolId, "tags"] as const;
/** The pool's "Tags" tab (`GET /pools/:id/tags/usage`): under the tags, so their refresh reaches it. */
export const poolTagUsageKey = (poolId: string) => ["pool", poolId, "tags", "usage"] as const;
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

/**
 * `GET /pools/:id/question-stats` (ADR-038): under the pool, so a pool hint
 * — a reset included — refreshes it with the list it decorates.
 */
export const poolQuestionStatsKey = (poolId: string) => ["pool", poolId, "question-stats"] as const;

export const questionKey = (id: string) => ["question", id] as const;
/** `POST /questions/:id/preview` of the draft or of one published version. */
export const questionPreviewKey = (id: string, source: "draft" | number | undefined) =>
  ["question", id, "preview", source] as const;
/**
 * `POST /questions/:id/draft/instances` (ADR-056 §8), per stored draft: the
 * stamp of the draft it was drawn from, so every save draws again.
 */
export const questionInstancesKey = (id: string, stamp: string) =>
  ["question", id, "instances", stamp] as const;

// --- Evaluations ---------------------------------------------------------------

export const evaluationsKey = (classroomId: string) => ["evaluations", classroomId] as const;
/**
 * `GET /activities` (#190): every evaluation and poll the teacher manages.
 * Its own root, refreshed by every hint that touches an evaluation
 * (`realtime/hints.ts`).
 */
export const activitiesKey = ["activities"] as const;
/** Under `activitiesKey`, so every hint that refreshes the list refreshes it too. */
export const activityStatsKey = ["activities", "stats"] as const;
export const evaluationKey = (id: string) => ["evaluation", id] as const;
/** The summary of a template pull (F-EVAL-26): under the evaluation, so its refresh reaches it. */
export const templatePullKey = (id: string) => ["evaluation", id, "pull-template"] as const;
/** `GET /templates/:id`, the editor of one template (F-EVAL-25). */
/** "Allow drill" and the cards the evaluation gave rise to (ADR-041 §10). */
export const evaluationDrillKey = (id: string) => ["evaluation", id, "drill"] as const;
export const templateKey = (id: string) => ["template", id] as const;
/**
 * One item at its frozen version (issue #127), under the key of the
 * evaluation or the template that holds it. The version is in the key, so
 * an "Update" on the row is a new preview and not a stale cached one.
 */
export const itemPreviewKey = (
  owner: ReturnType<typeof evaluationKey> | ReturnType<typeof templateKey>,
  itemId: string,
  versionId: string,
) => [...owner, "item-preview", itemId, versionId] as const;
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
/** One question's answers for the whole class (F-DASH-07): a snapshot, refreshed by hand. */
export const itemAnswersKey = (evaluationId: string, itemId: string) =>
  ["item-answers", evaluationId, itemId] as const;

// --- Grading and results -------------------------------------------------------

/** The prefix of every grading read of one evaluation. */
export const gradingKey = (evaluationId: string) => ["grading", evaluationId] as const;
/** The questions and the state of each (the question selector). */
export const gradingStepsKey = (evaluationId: string) => ["grading", evaluationId, "steps"] as const;
/** One question's answers. `anonymous` is the `"0"`/`"1"` the request carries. */
export const gradingQueueKey = (evaluationId: string, itemId: string | null, anonymous: string) =>
  ["grading", evaluationId, "queue", itemId, anonymous] as const;
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
/** One student's copy, as the teacher opens it from the grade table. */
export const resultsCopyKey = (evaluationId: string, attemptId: string) =>
  ["results", evaluationId, "copy", attemptId] as const;

// --- Students ------------------------------------------------------------------

/** Every read of the student's own pages: what a project's write (Accept, Resend) invalidates (M3-13). */
export const studentRootKey = ["student"] as const;
export const studentHomeKey = [...studentRootKey, "home"] as const;
/** The student's project (F-PROJ-15), under the root the `projects` hint refreshes. */
export const studentProjectKey = (id: string) => [...studentRootKey, "project", id] as const;
export const studentClassroomsKey = ["student", "classrooms"] as const;
/** The student's Grades (`GET /student/results`), under the `student` root the `results` hint refreshes. */
export const studentGradesKey = ["student", "grades"] as const;
/** One classroom's student page (F-ORG-15), under the Courses list's key. */
export const studentClassroomKey = (id: string) => [...studentClassroomsKey, id] as const;
/**
 * The classroom's group sets as its student reads them (F-PROJ-22, M3-17):
 * under the student's classroom, so the `student` root — which the
 * `groups` hint names — reaches it.
 */
export const studentGroupSetsKey = (classroomId: string) => [...studentClassroomKey(classroomId), "group-sets"] as const;
/** Every drill read of the student (ADR-041): what an opt-out or a finished session invalidates. */
export const drillRootKey = ["student", "drill"] as const;
/** The classrooms whose drill the student is in or opted out of. */
export const drillClassroomsKey = [...drillRootKey, "classrooms"] as const;
/** Today's drill session, for one device class (its reference times are that class's). */
export const drillSessionKey = (device: string) => [...drillRootKey, "session", device] as const;
/**
 * One card served (`POST /drill/cards/:id/serve`). Outside the `student`
 * root on purpose: a hint must not re-serve a card the student already
 * answered.
 */
export const drillServeKey = (cardId: string) => ["drill-serve", cardId] as const;
export const attemptKey = (attemptId: string) => ["attempt", attemptId] as const;
export const attemptFeedbackKey = (attemptId: string) =>
  ["attempt", attemptId, "feedback"] as const;
/** The `POST …/attempt` behind the attempt route. */
export const attemptEntryKey = (evaluationId: string) =>
  ["attempt", "enter", evaluationId] as const;

// --- Polls ---------------------------------------------------------------------

export const pollQuestionsKey = ["poll-questions"] as const;
/** The launcher's "From pools", keyed by its first page's query string. */
export const pollPoolQuestionsKey = (search: string) => ["poll-pool-questions", search] as const;
export const pollKey = (id: string) => ["poll", id] as const;
export const pollIdeasKey = (id: string) => ["poll", id, "ideas"] as const;
export const publicPollKey = (code: string) => ["poll", "public", code] as const;
