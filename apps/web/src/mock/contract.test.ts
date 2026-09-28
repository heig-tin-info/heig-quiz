// @vitest-environment jsdom
/**
 * Invariant 7, extended to the mock (FC-17). The fake backend answers 121
 * routes with hand-written objects, and nothing used to check them: a mock
 * that has drifted from `@quiz/contracts` is a screenshot of a screen that
 * cannot exist. This walks its route table, calls every GET through the very
 * `window.fetch` the app calls, and parses the answer with the schema the
 * real route answers with — every question of every pool, every evaluation
 * of the classroom, both grading worlds and every poll, because one call per
 * route would only ever check the first type and the first state.
 *
 * Two things are deliberately out of its reach:
 *
 *  - the routes whose payload is a plain interface of `contracts/api.ts` have
 *    no schema to parse with. They are named in `UNCHECKED`, and the last
 *    test fails when a GET route is in neither list: a new route has to be
 *    classified, not forgotten;
 *  - a `uuid` format issue is dropped. The mock writes an id by hand wherever
 *    a human types one into a URL (`p1`, `q2`, `r1`) and a real UUID only
 *    where a frame of the SSE stream carries it, which is the rule the header
 *    of `index.ts` states and the one the SSE client enforces at runtime.
 *    Making those ids UUIDs would cost the screenshot script and the eye
 *    every readable URL the mock has. Every other issue — a missing key, a
 *    wrong type, an unknown enum member, an array where an object belongs —
 *    is a failure.
 */
import {
  ActivitySummary,
  AdminUser,
  AttemptInspect,
  AttemptOrLobby,
  ByQuestion,
  CourseDetail,
  DashboardView,
  EvaluationDetail,
  EvaluationSummary,
  EvaluationTemplate,
  GradingProgress,
  GradingQueue,
  GradingSteps,
  ItemPreview,
  ItemVersions,
  NotificationList,
  NotificationSettings,
  ApiToken,
  OAuthConnection,
  OAuthRequestView,
  PollPoolPage,
  PollPublicView,
  PollQuestionPick,
  PollSummary,
  PollTeacherView,
  PoolCandidates,
  PoolCategories,
  PoolDetail,
  PoolMembers,
  PoolSummary,
  PoolTag,
  QuestionDetail,
  QuestionPage,
  ResultsView,
  StudentFeedback,
  StudentHome,
  TemplateDetail,
  TemplatePullPreview,
} from "@quiz/contracts";
import { describe, expect, it } from "vitest";

// jsdom has no `fetch`; the mock wraps whatever is there and only defers to
// it for a URL outside `/app/`, which this test never asks for.
if (typeof window.fetch !== "function") {
  window.fetch = (() => Promise.reject(new Error("no network in this test"))) as typeof fetch;
}

await import("./index");
const { routes } = await import("./runtime");
const { STUDENT_ATTEMPT, STUDENT_RETAKE_ATTEMPT } = await import("./student");

interface Issue {
  code: string;
  format?: string;
  path: PropertyKey[];
  message: string;
}
interface Schema {
  safeParse: (v: unknown) => { success: boolean; error?: { issues: Issue[] } };
}

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(path);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json() as Promise<unknown>;
};

const issuesOf = (schema: Schema, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  return (parsed.error?.issues ?? [])
    .filter((i) => !(i.code === "invalid_format" && i.format === "uuid"))
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
};
const issuesOfEach = (schema: Schema, value: unknown): string[] => {
  if (!Array.isArray(value)) return ["<root>: expected an array"];
  return value.flatMap((v, i) => issuesOf(schema, v).map((m) => `[${i}].${m}`));
};

// --- The ids, taken from what the fixtures themselves serve ----------------

interface Ref {
  id: string;
}
const pools = (await get("/app/api/pools")) as Ref[];
const questionIds: string[] = [];
for (const pool of pools) {
  const page = (await get(`/app/api/pools/${pool.id}/questions`)) as { items: Ref[] };
  questionIds.push(...page.items.map((q) => q.id));
}

const courses = (await get("/app/api/courses")) as (Ref & { classrooms: Ref[] })[];
const classroomId = courses[0]!.classrooms[0]!.id;
const evaluations = (await get(`/app/api/classrooms/${classroomId}/evaluations`)) as {
  id: string;
  state: string;
  templateRevision: number | null;
}[];
const byState = (state: string): string => {
  const found = evaluations.find((e) => e.state === state);
  if (!found) throw new Error(`the mock has no ${state} evaluation`);
  return found.id;
};
const runningId = byState("running");
/** The two grading worlds: one still being graded, one released. */
const gradedIds = [byState("closed"), byState("released")];

const runningItems = (
  (await get(`/app/api/evaluations/${runningId}`)) as { items: Ref[] }
).items.map((i) => i.id);
const dashboard = (await get(`/app/api/evaluations/${runningId}/dashboard`)) as {
  rows: { attemptId: string | null }[];
};
const attemptId = dashboard.rows.find((r) => r.attemptId !== null)!.attemptId!;
const gradedAttempts: string[] = [];
const gradedItems: string[] = [];
for (const id of gradedIds) {
  const results = (await get(`/app/api/evaluations/${id}/results`)) as {
    items: Ref[];
    rows: { attemptId: string | null }[];
  };
  gradedItems.push(results.items[0]!.id);
  gradedAttempts.push(results.rows.find((r) => r.attemptId !== null)!.attemptId!);
}
/** The course's templates (ADR-031), and the items of the first one. */
const templateIds = (
  (await get(`/app/api/courses/${courses[0]!.id}/templates`)) as Ref[]
).map((x) => x.id);
const templateItems = (
  (await get(`/app/api/templates/${templateIds[0]}`)) as { items: Ref[] }
).items.map((i) => i.id);
const polls = (await get("/app/api/polls")) as { id: string; code: string | null }[];

// --- Route -> schema -------------------------------------------------------

type Shape = "one" | "each";
interface Case {
  /** The route as it is registered: what the last test matches the table on. */
  route: string;
  path: string;
  schema: Schema;
  shape: Shape;
}
const one = (route: string, path: string, schema: Schema): Case => ({
  route,
  path,
  schema,
  shape: "one",
});
const each = (route: string, path: string, schema: Schema): Case => ({
  route,
  path,
  schema,
  shape: "each",
});

const CHECKED: Case[] = [
  one("/app/api/courses/:id", `/app/api/courses/${courses[0]!.id}`, CourseDetail),
  each(
    "/app/api/courses/:id/templates",
    `/app/api/courses/${courses[0]!.id}/templates`,
    EvaluationTemplate,
  ),
  // F-EVAL-25: every template's editor, its picker's pools, and each item's preview.
  ...templateIds.flatMap((id) => [
    one("/app/api/templates/:id", `/app/api/templates/${id}`, TemplateDetail),
    each("/app/api/templates/:id/pools", `/app/api/templates/${id}/pools`, PoolSummary),
  ]),
  ...templateItems.map((itemId) =>
    one(
      "/app/api/templates/:id/preview/items/:itemId",
      `/app/api/templates/${templateIds[0]}/preview/items/${itemId}`,
      ItemPreview,
    ),
  ),
  each(
    "/app/api/classrooms/:id/evaluations",
    `/app/api/classrooms/${classroomId}/evaluations`,
    EvaluationSummary,
  ),
  each("/app/api/pools", "/app/api/pools", PoolSummary),
  ...pools.flatMap((p) => [
    one("/app/api/pools/:id", `/app/api/pools/${p.id}`, PoolDetail),
    one("/app/api/pools/:id/categories", `/app/api/pools/${p.id}/categories`, PoolCategories),
    one("/app/api/pools/:id/members", `/app/api/pools/${p.id}/members`, PoolMembers),
    one("/app/api/pools/:id/candidates", `/app/api/pools/${p.id}/candidates?q=a`, PoolCandidates),
    one("/app/api/pools/:id/questions", `/app/api/pools/${p.id}/questions`, QuestionPage),
    each("/app/api/pools/:id/tags", `/app/api/pools/${p.id}/tags`, PoolTag),
  ]),
  // Every question: the payload of a `circuit` is not the payload of an
  // `mcq`, and only the type that drifted would fail.
  ...questionIds.map((id) => one("/app/api/questions/:id", `/app/api/questions/${id}`, QuestionDetail)),
  one("/app/api/notifications", "/app/api/notifications", NotificationList),
  one("/app/api/notifications/settings", "/app/api/notifications/settings", NotificationSettings),
  each("/app/api/me/tokens", "/app/api/me/tokens", ApiToken),
  each("/app/api/me/connections", "/app/api/me/connections", OAuthConnection),
  one(
    "/app/api/oauth/requests/:id",
    "/app/api/oauth/requests/0190d3c4-0000-7000-8000-000000000001",
    OAuthRequestView,
  ),
  // Every state: a `draft` has no item and a `closed` no live row, and the
  // detail of each is a different half of the same schema.
  ...evaluations.map((e) =>
    one("/app/api/evaluations/:id", `/app/api/evaluations/${e.id}`, EvaluationDetail),
  ),
  // F-EVAL-26: the pull's summary, for every evaluation that still has its template.
  ...evaluations
    .filter((e) => e.templateRevision !== null)
    .map((e) =>
      one(
        "/app/api/evaluations/:id/pull-template",
        `/app/api/evaluations/${e.id}/pull-template`,
        TemplatePullPreview,
      ),
    ),
  each(
    "/app/api/evaluations/:id/pools",
    `/app/api/evaluations/${runningId}/pools`,
    PoolSummary,
  ),
  // Issue #127: one item at its frozen version, each type of the running one.
  ...runningItems.map((itemId) =>
    one(
      "/app/api/evaluations/:id/preview/items/:itemId",
      `/app/api/evaluations/${runningId}/preview/items/${itemId}`,
      ItemPreview,
    ),
  ),
  one(
    "/app/api/evaluations/:id/dashboard",
    `/app/api/evaluations/${runningId}/dashboard`,
    DashboardView,
  ),
  one(
    "/app/api/evaluations/:id/dashboard",
    `/app/api/evaluations/${runningId}/dashboard?includeAnswers=1`,
    DashboardView,
  ),
  one(
    "/app/api/evaluations/:id/attempts/:attemptId",
    `/app/api/evaluations/${runningId}/attempts/${attemptId}`,
    AttemptInspect,
  ),
  ...gradedIds.flatMap((id, i) => [
    one("/app/api/evaluations/:id/grading", `/app/api/evaluations/${id}/grading`, GradingQueue),
    one(
      "/app/api/evaluations/:id/grading",
      `/app/api/evaluations/${id}/grading?by=student&anonymous=0`,
      GradingQueue,
    ),
    one(
      "/app/api/evaluations/:id/grading/steps",
      `/app/api/evaluations/${id}/grading/steps?by=question&anonymous=1`,
      GradingSteps,
    ),
    one(
      "/app/api/evaluations/:id/grading/steps",
      `/app/api/evaluations/${id}/grading/steps?by=student&anonymous=0`,
      GradingSteps,
    ),
    one(
      "/app/api/evaluations/:id/grading/progress",
      `/app/api/evaluations/${id}/grading/progress`,
      GradingProgress,
    ),
    one(
      "/app/api/evaluations/:id/items/:itemId/versions",
      `/app/api/evaluations/${id}/items/${gradedItems[i]}/versions`,
      ItemVersions,
    ),
    one("/app/api/evaluations/:id/results", `/app/api/evaluations/${id}/results`, ResultsView),
    each(
      "/app/api/evaluations/:id/results/by-question",
      `/app/api/evaluations/${id}/results/by-question?itemId=${gradedItems[i]}`,
      ByQuestion,
    ),
    // Released: the whole feedback. Still being graded: the refusal, which is
    // the other branch of the same discriminated union.
    one(
      "/app/api/attempts/:id/feedback",
      `/app/api/attempts/${gradedAttempts[i]}/feedback`,
      StudentFeedback,
    ),
  ]),
  each("/app/api/admin/users", "/app/api/admin/users", AdminUser),
  each("/app/api/polls", "/app/api/polls", PollSummary),
  // The Activities section (#190).
  each("/app/api/activities", "/app/api/activities", ActivitySummary),
  each("/app/api/polls/questions", "/app/api/polls/questions", PollQuestionPick),
  one("/app/api/polls/pool-questions", "/app/api/polls/pool-questions", PollPoolPage),
  ...polls.map((p) =>
    one("/app/api/evaluations/:id/poll", `/app/api/evaluations/${p.id}/poll`, PollTeacherView),
  ),
  ...polls
    .filter((p) => p.code !== null)
    .map((p) => one("/app/api/p/:code", `/app/api/p/${p.code}`, PollPublicView)),
  one("/app/api/attempts/:id", `/app/api/attempts/${attemptId}`, AttemptOrLobby),
  one("/app/api/student/home", "/app/api/student/home", StudentHome),
  // F-EVAL-15: the score-only feedback between two attempts of an exercise.
  one(
    `/app/api/attempts/${STUDENT_RETAKE_ATTEMPT}/feedback`,
    `/app/api/attempts/${STUDENT_RETAKE_ATTEMPT}/feedback`,
    StudentFeedback,
  ),
  // Issue #203: the player's attempt, not released — the Handed-in screen asks.
  one(
    `/app/api/attempts/${STUDENT_ATTEMPT}/feedback`,
    `/app/api/attempts/${STUDENT_ATTEMPT}/feedback`,
    StudentFeedback,
  ),
];

/**
 * The GET routes whose payload is a plain interface of `contracts/api.ts`,
 * with nothing in the package to parse them with. Naming them here is the
 * check: giving them a schema is a change to the contract, not to the mock.
 */
const UNCHECKED = [
  "/app/api/config", // PublicConfig
  "/app/api/me", // Me
  "/app/api/courses", // CourseSummary[]
  "/app/api/classrooms/:id", // ClassroomDetail
  "/app/api/student/classrooms", // StudentClassroom[]
  "/app/api/admin/teachers", // AdminTeacher[]
];

describe("the mock answers what the contracts describe", () => {
  it.each(CHECKED.map((c) => [c.path, c] as const))("GET %s", async (path, c) => {
    const body = await get(path);
    const issues = c.shape === "one" ? issuesOf(c.schema, body) : issuesOfEach(c.schema, body);
    expect(issues, `GET ${path}\n${issues.join("\n")}`).toEqual([]);
  });

  it("classifies every GET route of the table", () => {
    const registered = routes
      .filter((r) => r.method === "GET")
      // `^\/app\/api\/pools\/(?<id>[^\/]+)$` back to `/app/api/pools/:id`
      .map((r) => r.re.source.slice(1, -1).replace(/\\\//g, "/"))
      .map((s) => s.replace(/\(\?<(\w+)>\[\^\/\]\+\)/g, ":$1"));
    const classified = new Set([...CHECKED.map((c) => c.route), ...UNCHECKED]);
    expect(registered.filter((r) => !classified.has(r))).toEqual([]);
  });
});
