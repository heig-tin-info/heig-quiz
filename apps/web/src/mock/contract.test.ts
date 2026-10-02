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
  ActivityStats,
  ActivitySummary,
  AdminScheduledTask,
  AdminUser,
  SystemStatus,
  LlmAvailability,
  ReviewList,
  LlmSettings,
  LlmUsage,
  AttemptInspect,
  AttemptOrLobby,
  ByQuestion,
  CourseDetail,
  DashboardView,
  DrillClassroom,
  DrillProgress,
  DrillSession,
  DrillStudentActivity,
  DrillTagMastery,
  EvaluationDetail,
  EvaluationDrill,
  EvaluationSummary,
  EvaluationTemplate,
  GithubAccountState,
  GithubClassroom,
  GithubOrg,
  GradingProgress,
  GradingQueue,
  GradingSteps,
  ItemPreview,
  PreviewSolution,
  ItemVersions,
  encodeJournalPath,
  Journal,
  JournalDeletedPage,
  JournalPage,
  JournalRevision,
  JournalRevisionContent,
  KioskDevice,
  KioskStation,
  PairPreview,
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
  ProjectActivitySummary,
  ProjectCreate,
  ProjectRefusal,
  ProjectSourceDetail,
  ProjectSourceRepo,
  ProjectSummary,
  PoolCandidates,
  PoolCategories,
  PoolDetail,
  PoolMembers,
  PoolQuestionStats,
  PoolSummary,
  PoolTag,
  QuestionDetail,
  QuestionPage,
  ResultsView,
  StudentFeedback,
  StudentClassroom,
  StudentClassroomPage,
  StudentHome,
  GradeGroup,
  TemplateDetail,
  TemplatePullPreview,
} from "@quiz/contracts";
import { beforeEach, describe, expect, it } from "vitest";

// jsdom has no `fetch`; the mock wraps whatever is there and only defers to
// it for a URL outside `/app/`, which this test never asks for.
if (typeof window.fetch !== "function") {
  window.fetch = (() => Promise.reject(new Error("no network in this test"))) as typeof fetch;
}

// `?journal=1`, as the runtime remembers it: PRG1-2026 has a journal, so its
// pages are served and checked; every other classroom answers "no journal".
localStorage.setItem("quiz-mock-journal", "1");
// `?projects=1` (M3-10): PRG1-2026 has a project in each state, so the
// classroom's list and the Activities' project rows are served and checked.
localStorage.setItem("quiz-mock-projects", "1");
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
/** A student seat of the classroom, for one student's drill progression. */
const firstSeat = ((await get(`/app/api/classrooms/${classroomId}`)) as { roster: Ref[] }).roster[0]!.id;
/** The repositories PRG1-2026's organization may hand out (M3-11, `?projects=1`). */
const sourceNames = ((await get(`/app/api/classrooms/${classroomId}/projects/sources`)) as { name: string }[]).map(
  (s) => s.name,
);
/** Every page of the classroom's journal (its home and its staff navigation), and whether a student reads it. */
interface Nav {
  pagePath: string | null;
  children: Nav[];
}
const journal = (await get(`/app/api/classrooms/${classroomId}/journal`)) as {
  nav: Nav[];
  homePath: string | null;
  hiddenPaths: string[];
};
const pagesOf = (nodes: Nav[]): string[] =>
  nodes.flatMap((n) => [...(n.pagePath ? [n.pagePath] : []), ...pagesOf(n.children)]);
const journalPages = [...new Set([...(journal.homePath ? [journal.homePath] : []), ...pagesOf(journal.nav)])].map((path) => ({
  path,
  student: !journal.hiddenPaths.includes(path),
}));
/** A page of the Quiz-mode journal, and one of its revisions (ADR-057). */
const revisedPage = journal.homePath ?? journalPages[0]!.path;
const revisionsUrl = `/app/api/classrooms/${classroomId}/journal/revisions/${encodeJournalPath(revisedPage)}`;
const revisionId = ((await get(revisionsUrl)) as { id: string }[])[0]!.id;

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
  ...templateItems.map((itemId) =>
    one(
      "/app/api/templates/:id/preview/items/:itemId/solution",
      `/app/api/templates/${templateIds[0]}/preview/items/${itemId}/solution`,
      PreviewSolution,
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
    one("/app/api/pools/:id/question-stats", `/app/api/pools/${p.id}/question-stats`, PoolQuestionStats),
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
  ...runningItems.map((itemId) =>
    one(
      "/app/api/evaluations/:id/preview/items/:itemId/solution",
      `/app/api/evaluations/${runningId}/preview/items/${itemId}/solution`,
      PreviewSolution,
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
      `/app/api/evaluations/${id}/grading?anonymous=0`,
      GradingQueue,
    ),
    one("/app/api/evaluations/:id/grading/steps", `/app/api/evaluations/${id}/grading/steps`, GradingSteps),
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
  each("/app/api/admin/tasks", "/app/api/admin/tasks", AdminScheduledTask),
  each("/app/api/admin/kiosk-devices", "/app/api/admin/kiosk-devices", KioskDevice),
  one("/app/api/kiosk/station", "/app/api/kiosk/station", KioskStation),
  one("/app/api/pair/:code", "/app/api/pair/BCDF-GHJK", PairPreview),
  one("/app/api/admin/system", "/app/api/admin/system", SystemStatus),
  one("/app/api/admin/llm", "/app/api/admin/llm", LlmSettings),
  one("/app/api/generate/availability", "/app/api/generate/availability", LlmAvailability),
  one("/app/api/pools/:id/reviews", "/app/api/pools/p1/reviews", ReviewList),
  one("/app/api/admin/llm/usage", "/app/api/admin/llm/usage", LlmUsage),
  each("/app/api/polls", "/app/api/polls", PollSummary),
  // The Activities section (#190).
  each("/app/api/activities", "/app/api/activities", ActivitySummary),
  one("/app/api/activities/stats", "/app/api/activities/stats", ActivityStats),
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
  // F-ORG-14, F-RES-04: the student's Grades, by classroom.
  each("/app/api/student/results", "/app/api/student/results", GradeGroup),
  // M5-01: the Courses list, and the page of each classroom it lists.
  each("/app/api/student/classrooms", "/app/api/student/classrooms", StudentClassroom),
  ...["r1", "r2"].map((id) =>
    one("/app/api/student/classrooms/:id", `/app/api/student/classrooms/${id}`, StudentClassroomPage),
  ),
  // The journal (F-JRN-07): the staff payload with and without a journal, the
  // student payload (`?view=student`), and every page both ways.
  ...courses
    .flatMap((c) => c.classrooms)
    .map((r) => one("/app/api/classrooms/:id/journal", `/app/api/classrooms/${r.id}/journal`, Journal)),
  one(
    "/app/api/classrooms/:id/journal",
    `/app/api/classrooms/${classroomId}/journal?view=student`,
    Journal,
  ),
  ...journalPages.flatMap(({ path, student }) =>
    ["", ...(student ? ["?view=student"] : [])].map((query) =>
      one(
        "/app/api/classrooms/:id/journal/pages/(?<path>.+)",
        `/app/api/classrooms/${classroomId}/journal/pages/${encodeJournalPath(path)}${query}`,
        JournalPage,
      ),
    ),
  ),
  // The Quiz-mode journal's history (ADR-057): a page's revisions, one
  // revision with its markdown, the deleted pages.
  each("/app/api/classrooms/:id/journal/revisions/(?<path>.+)", revisionsUrl, JournalRevision),
  one(
    "/app/api/classrooms/:id/journal/revision/:rev",
    `/app/api/classrooms/${classroomId}/journal/revision/${revisionId}`,
    JournalRevisionContent,
  ),
  each("/app/api/classrooms/:id/journal/deleted", `/app/api/classrooms/${classroomId}/journal/deleted`, JournalDeletedPage),
  // GitHub (F-GH-01 to F-GH-05): the organizations, every classroom's link
  // (connected or not), and the persona's account.
  each("/app/api/github/orgs", "/app/api/github/orgs", GithubOrg),
  ...courses
    .flatMap((c) => c.classrooms)
    .map((r) => one("/app/api/classrooms/:id/github", `/app/api/classrooms/${r.id}/github`, GithubClassroom)),
  one("/app/api/me/github", "/app/api/me/github", GithubAccountState),
  // The projects (M3-10): every classroom's list, three rows on PRG1-2026.
  ...courses
    .flatMap((c) => c.classrooms)
    .map((r) => each("/app/api/classrooms/:id/projects", `/app/api/classrooms/${r.id}/projects`, ProjectActivitySummary)),
  // The new project's picker (M3-11): the connected classroom's repositories, each in detail.
  each("/app/api/classrooms/:id/projects/sources", `/app/api/classrooms/${classroomId}/projects/sources`, ProjectSourceRepo),
  ...sourceNames.map((name) =>
    one(
      "/app/api/classrooms/:id/projects/sources/:repo",
      `/app/api/classrooms/${classroomId}/projects/sources/${name}`,
      ProjectSourceDetail,
    ),
  ),
  // The drill (ADR-041, #317): the student's tab and the teacher's switch.
  one("/app/api/drill/session", "/app/api/drill/session", DrillSession),
  each("/app/api/drill/classrooms", "/app/api/drill/classrooms", DrillClassroom),
  ...evaluations.map((e) =>
    one("/app/api/evaluations/:id/drill", `/app/api/evaluations/${e.id}/drill`, EvaluationDrill),
  ),
  // The teacher's view of the classroom's drill (slice 4).
  each(
    "/app/api/classrooms/:id/drill/activity",
    `/app/api/classrooms/${classroomId}/drill/activity`,
    DrillStudentActivity,
  ),
  one(
    "/app/api/classrooms/:id/drill/progress",
    `/app/api/classrooms/${classroomId}/drill/progress?student=${firstSeat}`,
    DrillProgress,
  ),
  each("/app/api/classrooms/:id/drill/mastery", `/app/api/classrooms/${classroomId}/drill/mastery`, DrillTagMastery),
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
  "/app/api/admin/teachers", // AdminTeacher[]
];

// ADR-051 §7: one pending pairing (the mock keeps it in localStorage, which
// the setup clears before every test), so `/app/api/pair/:code` names a station.
beforeEach(() => {
  localStorage.setItem(
    "quiz-mock-kiosk-pairing",
    JSON.stringify({ deviceCode: "d", userCode: "BCDF-GHJK", expiresAt: Date.now() + 60_000, state: "pending", evaluationId: null }),
  );
});

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

describe("the mock's projects (?projects=1)", () => {
  it("serves one project per state, on PRG1-2026 and in the Activities", async () => {
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { state: string }[];
    expect(own.map((p) => p.state).sort()).toEqual(["draft", "locked", "published"]);
    const all = (await get("/app/api/activities")) as { kind: string }[];
    expect(all.filter((a) => a.kind === "project")).toHaveLength(3);
  });
});

describe("the mock numbers what the API numbers", () => {
  // `evaluation_items.position` is 0-based on the wire and every screen adds
  // one; a mock counting from 1 titled question 1 "2." in the re-grade sheet.
  it.each(evaluations.map((e) => [e.id] as const))("items of %s count from 0", async (id) => {
    const body = (await get(`/app/api/evaluations/${id}`)) as { items: { position: number }[] };
    expect(body.items.map((i) => i.position)).toEqual(body.items.map((_, i) => i));
  });
});

// Last: the create adds a draft to PRG1-2026's projects, which the checks above count.
describe("the mock's new project (M3-11)", () => {
  const post = async (classroom: string, body: unknown) => {
    const res = await fetch(`/app/api/classrooms/${classroom}/projects`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const body = (sourceRepo: string) =>
    ProjectCreate.parse({ name: "Labo 4", sourceRepo, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });

  it("creates a draft the classroom's projects then list", { timeout: 10_000 }, async () => {
    const created = await post(classroomId, body(sourceNames[0]!));
    expect(created.status).toBe(200);
    expect(issuesOf(ProjectSummary, created.body)).toEqual([]);
    const own = (await get(`/app/api/classrooms/${classroomId}/projects`)) as { id: string }[];
    expect(own.map((p) => p.id)).toContain((created.body as { id: string }).id);
  });

  it("refuses with the bodies the form reads", async () => {
    const other = courses.flatMap((c) => c.classrooms).find((r) => r.id !== classroomId)!.id;
    const notConnected = await post(other, body(sourceNames[0]!));
    expect(notConnected.status).toBe(409);
    expect(ProjectRefusal.parse(notConnected.body).error).toBe("not_connected");
    const unknown = await post(classroomId, body("no-such-repo"));
    expect(unknown.status).toBe(422);
    expect(ProjectRefusal.parse(unknown.body).error).toBe("source_not_found");
  });
});
