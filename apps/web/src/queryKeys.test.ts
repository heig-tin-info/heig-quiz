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
    ["adminTeachersKey", keys.adminTeachersKey, ["admin-teachers"]],
    ["apiTokensKey", keys.apiTokensKey, ["api-tokens"]],
    ["connectionsKey", keys.connectionsKey, ["oauth-connections"]],
    ["oauthRequestKey", keys.oauthRequestKey("q1"), ["oauth-request", "q1"]],
    ["coursesKey", keys.coursesKey, ["courses"]],
    ["courseKey", keys.courseKey("c1"), ["course", "c1"]],
    ["classroomKey", keys.classroomKey("r1"), ["classroom", "r1"]],
    ["classroomKey (not loaded)", keys.classroomKey(null), ["classroom", null]],
    ["poolsKey", keys.poolsKey, ["pools"]],
    ["allPoolsKey", keys.allPoolsKey, ["pools", "all"]],
    ["evaluationPoolsKey", keys.evaluationPoolsKey("e1"), ["pools", "evaluation", "e1"]],
    ["anyPoolKey", keys.anyPoolKey, ["pool"]],
    ["poolKey", keys.poolKey("p1"), ["pool", "p1"]],
    ["poolKey (not loaded)", keys.poolKey(undefined), ["pool", undefined]],
    ["poolTagsKey", keys.poolTagsKey("p1"), ["pool", "p1", "tags"]],
    ["poolCategoriesKey", keys.poolCategoriesKey("p1"), ["pool", "p1", "categories"]],
    ["poolMembersKey", keys.poolMembersKey("p1"), ["pool-members", "p1"]],
    ["poolCandidatesKey", keys.poolCandidatesKey("p1"), ["pool-candidates", "p1"]],
    ["poolCandidatesKey (q)", keys.poolCandidatesKey("p1", "ma"), ["pool-candidates", "p1", "ma"]],
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
    ["evaluationsKey", keys.evaluationsKey("r1"), ["evaluations", "r1"]],
    ["evaluationKey", keys.evaluationKey("e1"), ["evaluation", "e1"]],
    ["dashboardKey", keys.dashboardKey("e1", true), ["dashboard", "e1", true, false]],
    [
      "dashboardKey (results)",
      keys.dashboardKey("e1", false, true),
      ["dashboard", "e1", false, true],
    ],
    ["attemptInspectKey", keys.attemptInspectKey("e1", "a1"), ["attempt-inspect", "e1", "a1"]],
    ["gradingKey", keys.gradingKey("e1"), ["grading", "e1"]],
    [
      "gradingRosterKey",
      keys.gradingRosterKey("e1", "i1", "1"),
      ["grading", "e1", "roster", "i1", "1"],
    ],
    [
      "gradingQueueKey",
      keys.gradingQueueKey("e1", "by=question&itemId=i1", "proposed", "0"),
      ["grading", "e1", "queue", "by=question&itemId=i1", "proposed", "0"],
    ],
    ["gradingProgressKey", keys.gradingProgressKey("e1"), ["grading", "e1", "progress"]],
    ["resultsKey", keys.resultsKey("e1"), ["results", "e1"]],
    ["resultsViewKey", keys.resultsViewKey("e1"), ["results", "e1", "view"]],
    ["resultsByQuestionKey", keys.resultsByQuestionKey("e1"), ["results", "e1", "by-question"]],
    ["studentHomeKey", keys.studentHomeKey, ["student", "home"]],
    ["studentClassroomsKey", keys.studentClassroomsKey, ["student", "classrooms"]],
    ["attemptKey", keys.attemptKey("a1"), ["attempt", "a1"]],
    ["attemptFeedbackKey", keys.attemptFeedbackKey("a1"), ["attempt", "a1", "feedback"]],
    ["attemptEntryKey", keys.attemptEntryKey("e1", null), ["attempt", "enter", "e1", null]],
    ["attemptEntryKey (code)", keys.attemptEntryKey("e1", "X7"), ["attempt", "enter", "e1", "X7"]],
    ["pollQuestionsKey", keys.pollQuestionsKey, ["poll-questions"]],
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
    [
      "questionKey ⊂ questionPreviewKey",
      keys.questionKey("q1"),
      keys.questionPreviewKey("q1", "draft"),
    ],
    [
      "gradingKey ⊂ gradingQueueKey",
      keys.gradingKey("e1"),
      keys.gradingQueueKey("e1", null, "all", "1"),
    ],
    [
      "gradingKey ⊂ gradingRosterKey",
      keys.gradingKey("e1"),
      keys.gradingRosterKey("e1", "i1", "1"),
    ],
    ["gradingKey ⊂ gradingProgressKey", keys.gradingKey("e1"), keys.gradingProgressKey("e1")],
    ["resultsKey ⊂ resultsViewKey", keys.resultsKey("e1"), keys.resultsViewKey("e1")],
    ["resultsKey ⊂ resultsByQuestionKey", keys.resultsKey("e1"), keys.resultsByQuestionKey("e1")],
    ["attemptKey ⊂ attemptFeedbackKey", keys.attemptKey("a1"), keys.attemptFeedbackKey("a1")],
  ] as const)("%s", (_name, prefix, key) => {
    expect(isPrefix(prefix, key)).toBe(true);
  });
});
