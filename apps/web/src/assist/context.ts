/**
 * What the teacher assistant knows of the screen (ADR-080 §2): the route
 * PATTERN, the screen's help topic and the UI language — never an id, a
 * title or a name — and where it is offered at all (§3).
 */
import { AssistContext, type Me } from "@quiz/contracts";

import type { Locale } from "../i18n";
import { routeToPath, type Route } from "../router";

/** The route fields that name an entity: each becomes `:<field>` in the pattern. */
const ENTITY_FIELDS: ReadonlySet<string> = new Set(["id", "classroomId", "evaluationId", "attemptId", "code"]);

/**
 * The route as a pattern (`/pools/:id`, `/courses/:id/pools`, `/admin?tab=llm`):
 * every entity field a parameter, the tabs kept (a closed vocabulary), every
 * other field dropped (a journal page's path, the editor's origin). A
 * pattern the contract would refuse becomes `/`: the question still goes.
 */
export function routePattern(route: Route): string {
  const placeholder = Object.fromEntries(
    Object.entries(route).flatMap(([key, value]) =>
      key === "view" || key === "tab" ? [[key, value]] : ENTITY_FIELDS.has(key) ? [[key, `:${key}`]] : [],
    ),
  ) as Route;
  const pattern = routeToPath(placeholder);
  return AssistContext.shape.route.safeParse(pattern).success ? pattern : "/";
}

/**
 * The help topic of each teacher screen (`apps/web/src/help/<topic>.md`), the
 * one its `PageHeader help` opens; none for the others.
 */
const HELP_TOPICS: Partial<Record<Route["view"], string>> = {
  home: "courses",
  settings: "mcq-policies",
  course: "courses",
  template: "courses",
  classroom: "classroom",
  classroomSettings: "classroom",
  classroomGrades: "classroom",
  classroomJournal: "journal",
  classroomGroups: "groups",
  groupSet: "groups",
  project: "project",
  projectNew: "project-new",
  pools: "pools",
  pool: "pool",
  poolCategories: "categories",
  question: "question-editor",
  evaluation: "evaluation",
  live: "live",
  grading: "grading",
  results: "results",
};

export function helpTopicOf(route: Route): string | null {
  if (route.view === "classroom" && route.tab === "roster") return "roster";
  return HELP_TOPICS[route.view] ?? null;
}

export function assistContext(route: Route, locale: Locale): AssistContext {
  return { route: routePattern(route), helpTopic: helpTopicOf(route), locale };
}

/**
 * Where the assistant is never drawn (ADR-080 §3): the projected screens
 * (a poll's wall, the correction's projection), the exam and the previews
 * of a student's screen, and every page of a guest or a station. They are
 * full-screen views already, outside the frame that hosts the button; the
 * list says so once more, so the rule does not rest on the layout.
 */
const NEVER: ReadonlySet<Route["view"]> = new Set([
  "poll",
  "correction",
  "attempt",
  "questionPreview",
  "evaluationPreview",
  "join",
  "oauthConsent",
  "teamsLink",
  "teamsTab",
  "pair",
  "kiosk",
]);

/**
 * Whether the assistant is offered: the teacher UI (a teacher or an
 * administrator, not in the student view, ADR-018), on their own portal
 * session (not an impersonation, ADR-034, nor a `seb` or `kiosk` one), on a
 * screen that is not projected. The server refuses the rest anyway.
 */
export function assistVisible(input: { teacherUi: boolean; me: Pick<Me, "role" | "session">; view: Route["view"] }): boolean {
  const { teacherUi, me, view } = input;
  return (
    teacherUi &&
    (me.role === "teacher" || me.role === "admin") &&
    (me.session?.kind ?? "portal") === "portal" &&
    !NEVER.has(view)
  );
}
