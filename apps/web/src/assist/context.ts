/**
 * What the teacher assistant knows of the screen (ADR-080 §2, amended for
 * P2): the route PATTERN, the screen's help topic — the one its
 * `PageHelpButton` opens, read from that button's slot
 * (`currentHelpTopic`) —, the UI language, and the ids of the entities on
 * it from a closed list of kinds; never a title, a name, nor a student's,
 * a user's or an attempt's id. And where it is offered at all (§3).
 */
import { AssistContext, AssistEntities, type Me } from "@quiz/contracts";
import type { AssistEntityKind } from "@quiz/domain";

import type { Locale } from "../i18n";
import { routeToPath, type Route } from "../router";
import { currentHelpTopic } from "../ui";

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

/** One id, as the contract checks it. */
const UUID = AssistEntities.shape.classroom;

/**
 * Which entity a view's `id` names (ADR-080 P2 amendment, item 3). A view
 * absent here gives none; the list of kinds is closed by the contract
 * (`AssistEntities`), so a project, a group set, an attempt or a student is
 * never sent, whatever its route carries.
 */
const ID_KIND: Partial<Record<Route["view"], AssistEntityKind>> = {
  course: "course",
  template: "template",
  classroom: "classroom",
  classroomSettings: "classroom",
  classroomJournal: "classroom",
  classroomGrades: "classroom",
  classroomGroups: "classroom",
  pool: "pool",
  poolCategories: "pool",
  question: "question",
  evaluation: "evaluation",
  live: "evaluation",
};

/**
 * The ids of what the screen shows, by kind: the view's `id` by
 * {@link ID_KIND}, a `classroomId` or an `evaluationId` field as such. An
 * id that is not a uuid (the browser mock's `r1`) is left out rather than
 * refused with the whole question.
 */
export function routeEntities(route: Route): AssistEntities {
  const fields = route as Partial<Record<"id" | "classroomId" | "evaluationId", string>>;
  const kind = ID_KIND[route.view];
  const found: Partial<Record<AssistEntityKind, string | undefined>> = {
    ...(kind ? { [kind]: fields.id } : {}),
    ...(fields.classroomId ? { classroom: fields.classroomId } : {}),
    ...(fields.evaluationId ? { evaluation: fields.evaluationId } : {}),
  };
  return Object.fromEntries(
    Object.entries(found).filter(([, id]) => id !== undefined && UUID.safeParse(id).success),
  ) as AssistEntities;
}

export function assistContext(route: Route, locale: Locale): AssistContext {
  const entities = routeEntities(route);
  return {
    route: routePattern(route),
    helpTopic: currentHelpTopic(),
    locale,
    ...(Object.keys(entities).length > 0 ? { entities } : {}),
  };
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
