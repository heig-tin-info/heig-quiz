import { describe, expect, it } from "vitest";

import * as keys from "./queryKeys";

/*
 * Every factory against the literal it replaced (FC-10 / FF-07). The values
 * are what TanStack Query hashes and what a prefix invalidation compares, so
 * a factory that reshapes its key silently stops matching the invalidations
 * written against the old shape — the screen goes stale and no other test
 * notices. The one deliberate change is `poolQuestionsKey`, pinned below.
 */
describe("queryKeys — each factory is the literal it replaced", () => {
  const cases: [string, readonly unknown[], readonly unknown[]][] = [
    ["configKey", keys.configKey, ["config"]],
    ["meKey", keys.meKey, ["me"]],
    ["notificationsKey", keys.notificationsKey, ["notifications"]],
    ["notificationSettingsKey", keys.notificationSettingsKey, ["notification-settings"]],
    ["adminTeachersKey", keys.adminTeachersKey, ["admin-teachers"]],
    ["adminUsersKey", keys.adminUsersKey, ["admin-teachers", "users"]],
    ["adminTasksKey", keys.adminTasksKey, ["admin-teachers", "tasks"]],
    ["adminLlmKey", keys.adminLlmKey, ["admin-teachers", "llm"]],
    ["generateAvailabilityKey", keys.generateAvailabilityKey, ["generate-availability"]],
    ["poolReviewsKey", keys.poolReviewsKey("p1"), ["pool", "p1", "reviews"]],
    ["adminLlmUsageKey", keys.adminLlmUsageKey, ["admin-teachers", "llm-usage"]],
    ["adminKioskKey", keys.adminKioskKey, ["admin-kiosk-devices"]],
    ["kioskStationKey", keys.kioskStationKey, ["kiosk-station"]],
    ["pairPreviewKey", keys.pairPreviewKey("BCDF-GHJK"), ["pair-preview", "BCDF-GHJK"]],
    ["adminSystemKey", keys.adminSystemKey, ["admin-system"]],
    ["apiTokensKey", keys.apiTokensKey, ["api-tokens"]],
    ["connectionsKey", keys.connectionsKey, ["oauth-connections"]],
    ["oauthRequestKey", keys.oauthRequestKey("q1"), ["oauth-request", "q1"]],
    ["teamsLinkKey", keys.teamsLinkKey("t1"), ["teams-link", "t1"]],
    ["teamsHostKey", keys.teamsHostKey, ["teams-host"]],
    ["teamsTabKey", keys.teamsTabKey, ["teams-tab"]],
    ["coursesKey", keys.coursesKey, ["courses"]],
    ["courseKey", keys.courseKey("c1"), ["course", "c1"]],
    ["courseTemplatesKey", keys.courseTemplatesKey("c1"), ["course", "c1", "templates"]],
    ["classroomKey", keys.classroomKey("r1"), ["classroom", "r1"]],
    ["classroomKey (not loaded)", keys.classroomKey(null), ["classroom", null]],
    ["classroomGithubKey", keys.classroomGithubKey("r1"), ["classroom", "r1", "github"]],
    ["classroomProjectsKey", keys.classroomProjectsKey("r1"), ["classroom", "r1", "projects"]],
    ["githubOrgsKey", keys.githubOrgsKey, ["github", "orgs"]],
    ["meGithubKey", keys.meGithubKey, ["me", "github"]],
    ["poolsKey", keys.poolsKey, ["pools"]],
    ["evaluationPoolsKey", keys.evaluationPoolsKey("e1"), ["pools", "evaluation", "e1"]],
    ["templatePoolsKey", keys.templatePoolsKey("t1"), ["pools", "template", "t1"]],
    ["anyPoolKey", keys.anyPoolKey, ["pool"]],
    ["poolKey", keys.poolKey("p1"), ["pool", "p1"]],
    ["poolKey (not loaded)", keys.poolKey(undefined), ["pool", undefined]],
    ["poolTagsKey", keys.poolTagsKey("p1"), ["pool", "p1", "tags"]],
    ["poolCategoriesKey", keys.poolCategoriesKey("p1"), ["pool", "p1", "categories"]],
    ["poolMembersKey", keys.poolMembersKey("p1"), ["pool-members", "p1"]],
    ["poolCandidatesKey", keys.poolCandidatesKey("p1"), ["pool-candidates", "p1"]],
    ["poolCandidatesKey (q)", keys.poolCandidatesKey("p1", "ma"), ["pool-candidates", "p1", "ma"]],
    ["poolQuestionStatsKey", keys.poolQuestionStatsKey("p1"), ["pool", "p1", "question-stats"]],
    ["poolQuestionListsKey", keys.poolQuestionListsKey("p1"), ["pool", "p1", "questions"]],
    ["poolStarredKey", keys.poolStarredKey("p1"), ["pool", "p1", "starred"]],
    ["questionKey", keys.questionKey("q1"), ["question", "q1"]],
    [
      "questionPreviewKey (draft)",
      keys.questionPreviewKey("q1", "draft"),
      ["question", "q1", "preview", "draft"],
    ],
    [
      "questionPreviewKey (version)",
      keys.questionPreviewKey("q1", 3),
      ["question", "q1", "preview", 3],
    ],
    [
      "questionInstancesKey",
      keys.questionInstancesKey("q1", "2026-10-01T10:00:00.000Z"),
      ["question", "q1", "instances", "2026-10-01T10:00:00.000Z"],
    ],
    ["evaluationsKey", keys.evaluationsKey("r1"), ["evaluations", "r1"]],
    ["activitiesKey", keys.activitiesKey, ["activities"]],
    ["evaluationKey", keys.evaluationKey("e1"), ["evaluation", "e1"]],
    ["templatePullKey", keys.templatePullKey("e1"), ["evaluation", "e1", "pull-template"]],
    ["templateKey", keys.templateKey("t1"), ["template", "t1"]],
    [
      "itemPreviewKey",
      keys.itemPreviewKey(keys.evaluationKey("e1"), "i1", "v1"),
      ["evaluation", "e1", "item-preview", "i1", "v1"],
    ],
    [
      "itemPreviewKey (template)",
      keys.itemPreviewKey(keys.templateKey("t1"), "i1", "v1"),
      ["template", "t1", "item-preview", "i1", "v1"],
    ],
    ["dashboardKey", keys.dashboardKey("e1", true), ["dashboard", "e1", true, false]],
    [
      "dashboardKey (results)",
      keys.dashboardKey("e1", false, true),
      ["dashboard", "e1", false, true],
    ],
    ["attemptInspectKey", keys.attemptInspectKey("e1", "a1"), ["attempt-inspect", "e1", "a1"]],
    ["attemptInspectPrefix", keys.attemptInspectPrefix("e1"), ["attempt-inspect", "e1"]],
    ["gradingKey", keys.gradingKey("e1"), ["grading", "e1"]],
    ["gradingStepsKey", keys.gradingStepsKey("e1"), ["grading", "e1", "steps"]],
    [
      "gradingQueueKey",
      keys.gradingQueueKey("e1", "i1", "0"),
      ["grading", "e1", "queue", "i1", "0"],
    ],
    ["gradingProgressKey", keys.gradingProgressKey("e1"), ["grading", "e1", "progress"]],
    [
      "gradingItemVersionsKey",
      keys.gradingItemVersionsKey("e1", "i1"),
      ["grading", "e1", "versions", "i1"],
    ],
    ["resultsKey", keys.resultsKey("e1"), ["results", "e1"]],
    ["resultsViewKey", keys.resultsViewKey("e1"), ["results", "e1", "view"]],
    ["resultsByQuestionKey", keys.resultsByQuestionKey("e1"), ["results", "e1", "by-question"]],
    ["studentHomeKey", keys.studentHomeKey, ["student", "home"]],
    ["studentClassroomsKey", keys.studentClassroomsKey, ["student", "classrooms"]],
    ["studentGradesKey", keys.studentGradesKey, ["student", "grades"]],
    ["studentClassroomKey", keys.studentClassroomKey("r1"), ["student", "classrooms", "r1"]],
    ["drillRootKey", keys.drillRootKey, ["student", "drill"]],
    ["drillClassroomsKey", keys.drillClassroomsKey, ["student", "drill", "classrooms"]],
    ["drillSessionKey", keys.drillSessionKey("fine"), ["student", "drill", "session", "fine"]],
    ["drillServeKey", keys.drillServeKey("k1"), ["drill-serve", "k1"]],
    ["evaluationDrillKey", keys.evaluationDrillKey("e1"), ["evaluation", "e1", "drill"]],
    ["classroomDrillKey", keys.classroomDrillKey("r1", "activity"), ["classroom", "r1", "drill", "activity"]],
    ["journalRootKey", keys.journalRootKey("r1"), ["journal", "r1"]],
    ["journalKey", keys.journalKey("r1", "staff"), ["journal", "r1", "staff"]],
    ["journalPageKey", keys.journalPageKey("r1", "student", "README.md"), ["journal", "r1", "student", "page", "README.md"]],
    ["journalRevisionsKey", keys.journalRevisionsKey("r1", "README.md"), ["journal", "r1", "staff", "revisions", "README.md"]],
    ["journalDeletedKey", keys.journalDeletedKey("r1"), ["journal", "r1", "staff", "deleted"]],
    ["journalRevisionKey", keys.journalRevisionKey("r1", "v1"), ["journal", "r1", "staff", "revision", "v1"]],
    ["journalRevisionRenderedKey", keys.journalRevisionRenderedKey("r1", "v1"), ["journal", "r1", "staff", "revision", "v1", "rendered"]],
    ["attemptKey", keys.attemptKey("a1"), ["attempt", "a1"]],
    ["attemptFeedbackKey", keys.attemptFeedbackKey("a1"), ["attempt", "a1", "feedback"]],
    ["attemptEntryKey", keys.attemptEntryKey("e1"), ["attempt", "enter", "e1"]],
    ["pollQuestionsKey", keys.pollQuestionsKey, ["poll-questions"]],
    ["pollPoolQuestionsKey", keys.pollPoolQuestionsKey("?limit=25"), ["poll-pool-questions", "?limit=25"]],
    ["pollKey", keys.pollKey("e1"), ["poll", "e1"]],
    ["publicPollKey", keys.publicPollKey("ABC123"), ["poll", "public", "ABC123"]],
  ];

  it.each(cases)("%s", (_name, actual, literal) => {
    expect(actual).toEqual(literal);
  });

  it("covers every export of the module", () => {
    const covered = new Set(cases.map(([name]) => name.split(" ")[0]));
    const exported = Object.keys(keys).filter((name) => name !== "poolQuestionsKey");
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });
});

/*
 * The declared fix of FF-07. The pool screen's list was `["pool", id,
 * "questions", query]` and the evaluation picker's `["pool-questions", id,
 * search]`: one endpoint, two cache roots, and only the first one under the
 * pool key that every question write invalidates. Both now use this one.
 */
describe("queryKeys — the questions of a pool", () => {
  it("keeps the pool screen's shape", () => {
    expect(keys.poolQuestionsKey("p1", "?limit=25")).toEqual([
      "pool",
      "p1",
      "questions",
      "?limit=25",
    ]);
  });
});

/*
 * Invalidation matches by prefix. These are the prefixes the app relies on:
 * a write invalidates the short key and expects every read below it to go.
 */
describe("queryKeys — the prefixes invalidations rely on", () => {
  const isPrefix = (prefix: readonly unknown[], key: readonly unknown[]) =>
    prefix.every((part, i) => Object.is(part, key[i]));

  it.each([
    ["anyPoolKey ⊂ poolKey", keys.anyPoolKey, keys.poolKey("p1")],
    ["poolKey ⊂ poolQuestionsKey", keys.poolKey("p1"), keys.poolQuestionsKey("p1", "?limit=25")],
    ["poolKey ⊂ poolTagsKey", keys.poolKey("p1"), keys.poolTagsKey("p1")],
    ["poolKey ⊂ poolCategoriesKey", keys.poolKey("p1"), keys.poolCategoriesKey("p1")],
    [
      "poolCandidatesKey ⊂ poolCandidatesKey(q)",
      keys.poolCandidatesKey("p1"),
      keys.poolCandidatesKey("p1", "ma"),
    ],
    ["poolKey ⊂ poolQuestionStatsKey", keys.poolKey("p1"), keys.poolQuestionStatsKey("p1")],
    [
      "poolQuestionListsKey ⊂ poolQuestionsKey",
      keys.poolQuestionListsKey("p1"),
      keys.poolQuestionsKey("p1", "?limit=25"),
    ],
    ["poolKey ⊂ poolStarredKey", keys.poolKey("p1"), keys.poolStarredKey("p1")],
    [
      "questionKey ⊂ questionPreviewKey",
      keys.questionKey("q1"),
      keys.questionPreviewKey("q1", "draft"),
    ],
    ["questionKey ⊂ questionInstancesKey", keys.questionKey("q1"), keys.questionInstancesKey("q1", "s")],
    ["evaluationKey ⊂ templatePullKey", keys.evaluationKey("e1"), keys.templatePullKey("e1")],
    [
      "evaluationKey ⊂ itemPreviewKey",
      keys.evaluationKey("e1"),
      keys.itemPreviewKey(keys.evaluationKey("e1"), "i1", "v1"),
    ],
    [
      "templateKey ⊂ itemPreviewKey",
      keys.templateKey("t1"),
      keys.itemPreviewKey(keys.templateKey("t1"), "i1", "v1"),
    ],
    ["poolsKey ⊂ templatePoolsKey", keys.poolsKey, keys.templatePoolsKey("t1")],
    [
      "gradingKey ⊂ gradingQueueKey",
      keys.gradingKey("e1"),
      keys.gradingQueueKey("e1", null, "1"),
    ],
    ["gradingKey ⊂ gradingStepsKey", keys.gradingKey("e1"), keys.gradingStepsKey("e1")],
    ["gradingKey ⊂ gradingProgressKey", keys.gradingKey("e1"), keys.gradingProgressKey("e1")],
    ["resultsKey ⊂ resultsViewKey", keys.resultsKey("e1"), keys.resultsViewKey("e1")],
    ["resultsKey ⊂ resultsByQuestionKey", keys.resultsKey("e1"), keys.resultsByQuestionKey("e1")],
    ["attemptKey ⊂ attemptFeedbackKey", keys.attemptKey("a1"), keys.attemptFeedbackKey("a1")],
  ] as const)("%s", (_name, prefix, key) => {
    expect(isPrefix(prefix, key)).toBe(true);
  });
});
