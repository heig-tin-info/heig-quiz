/**
 * The screens the teacher assistant may open (ADR-080, P2b amendment): ONE
 * entry per view of the router's `Route` union — the mapped type makes a
 * view added to the router and forgotten here a compile error —, either the
 * screen as the assistant may open it, or `null` where it may not: a
 * student's screen, a projection, a preview, a guest's or a station's page,
 * a page whose ids no read tool returns, a creation form.
 *
 * Everything else is derived from the router: the pattern is
 * `routePattern` of the route, the ids' entity kinds are `routeEntities`'
 * closed table, the tabs are the router's own lists. The server reads the
 * same catalogue from `@quiz/domain` (`ASSIST_SCREENS`), a file GENERATED
 * from this one: `screens.test.ts` fails while the two differ, and
 * rewrites it under `UPDATE_ASSIST_SCREENS=1`.
 */
import type { AssistParamSpec, AssistScreenEntry } from "@quiz/domain";

import type { Dict } from "../i18n";
import {
  ADMIN_TABS,
  CLASSROOM_QUERY_TABS,
  COURSE_TABS,
  EVALUATION_STEPS,
  POOL_TABS,
  QUESTION_TABS,
  RESULTS_TABS,
  TEMPLATE_TABS,
  type Route,
} from "../router";
import { routeEntities, routePattern } from "./context";

export interface AssistScreenSpec {
  /** The screen's name, as the answer's "Opened:" line and the catalogue give it. */
  label: keyof Dict;
  /** The route fields that are ids, in the pattern's order. */
  ids?: readonly string[];
  /** The page header's help topic (`apps/web/src/help/<topic>.md`). */
  help?: string;
  /** The tabs, search and selection the assistant may set, each read by the screen off its address. */
  params?: Readonly<Record<string, AssistParamSpec>>;
  /** Offered to an administrator's assistant only. */
  admin?: true;
}

const tabs = (values: readonly string[]): AssistParamSpec => ({ kind: "enum", values });

/** The pool's search box: its grammar is `pool/searchSyntax.ts`'s, and the pool's help says it to the model too. */
const POOL_SEARCH: AssistParamSpec = {
  kind: "text",
  hint: "the search box: free text and tag:<name> type:<type id> difficulty:<n|>n|a-b> version:<n|>n>",
};

export const ASSIST_SCREEN_SPECS: { readonly [V in Route["view"]]: AssistScreenSpec | null } = {
  home: { label: "nav.courses", help: "courses" },
  settings: { label: "menu.settings" },
  admin: { label: "nav.admin", admin: true, params: { tab: tabs(ADMIN_TABS) } },
  course: { label: "assist.screen.course", ids: ["id"], help: "courses", params: { tab: tabs(COURSE_TABS) } },
  template: { label: "assist.screen.template", ids: ["id"], help: "courses", params: { tab: tabs(TEMPLATE_TABS) } },
  studentCourses: null,
  studentGrades: null,
  classroomSettings: { label: "assist.screen.classroomSettings", ids: ["id"], help: "classroom" },
  // A creation form: P3's, with the writes.
  projectNew: null,
  classroomJournal: { label: "assist.screen.classroomJournal", ids: ["id"], help: "journal" },
  // No read tool returns a group set's or a project's id.
  groupSet: null,
  classroomGroups: { label: "assist.screen.classroomGroups", ids: ["id"], help: "groups" },
  classroomGrades: { label: "assist.screen.classroomGrades", ids: ["id"], help: "classroom" },
  classroom: {
    label: "assist.screen.classroom",
    ids: ["id"],
    help: "classroom",
    params: { tab: tabs(CLASSROOM_QUERY_TABS) },
  },
  project: null,
  activities: { label: "nav.activities" },
  pools: { label: "pools.title", help: "pools" },
  poolCategories: { label: "assist.screen.poolCategories", ids: ["id"], help: "categories" },
  pool: {
    label: "pool.title",
    ids: ["id"],
    help: "pool",
    params: { tab: tabs(POOL_TABS), q: POOL_SEARCH, category: { kind: "id", of: "category" } },
  },
  polls: { label: "poll.launcher" },
  question: { label: "assist.screen.question", ids: ["id"], help: "question-editor", params: { tab: tabs(QUESTION_TABS) } },
  // A student's view of one question, where the assistant is never drawn.
  questionPreview: null,
  attempt: null,
  join: null,
  oauthConsent: null,
  teamsLink: null,
  teamsTab: null,
  kiosk: null,
  pair: null,
  feedback: null,
  drill: null,
  live: { label: "live.title", ids: ["id"], help: "live" },
  // Previews and projections: no assistant there (`assistVisible`).
  evaluationPreview: null,
  poll: null,
  pollModerate: null,
  grading: {
    label: "grading.title",
    ids: ["evaluationId"],
    help: "grading",
    params: { item: { kind: "id", of: "question" } },
  },
  results: { label: "results.title", ids: ["evaluationId"], help: "results", params: { tab: tabs(RESULTS_TABS) } },
  correction: null,
  evaluation: {
    label: "assist.screen.evaluation",
    ids: ["id"],
    help: "evaluation",
    params: { step: tabs(EVALUATION_STEPS) },
  },
  devUi: null,
};

/** A sample id for the `i`-th field, to read each field's kind off `routeEntities`. */
const sample = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** The route of `view` with `ids` in place (no check: the runner and the generator check). */
export const routeOf = (view: Route["view"], ids: Readonly<Record<string, string>>): Route =>
  ({ view, ...ids }) as Route;

/**
 * The catalogue as the server reads it (`ASSIST_SCREENS`), in the router's
 * order, each label in English (`en`, the dictionary the model reads).
 */
export function assistScreenEntries(en: Readonly<Record<string, string>>): AssistScreenEntry[] {
  return (Object.keys(ASSIST_SCREEN_SPECS) as Route["view"][]).flatMap((view) => {
    const spec = ASSIST_SCREEN_SPECS[view];
    if (!spec) return [];
    const fields = spec.ids ?? [];
    const placeholder = routeOf(view, Object.fromEntries(fields.map((f) => [f, `:${f}`])));
    const entities = Object.entries(routeEntities(routeOf(view, Object.fromEntries(fields.map((f, i) => [f, sample(i)])))));
    return [
      {
        screen: view,
        pattern: routePattern(placeholder),
        ids: fields.map((field, i) => ({ field, kind: entities.find(([, id]) => id === sample(i))?.[0] ?? "unknown" })),
        params: spec.params ?? {},
        title: en[spec.label] ?? spec.label,
        help: spec.help ?? null,
        audience: spec.admin ? "admin" : "staff",
      } as AssistScreenEntry,
    ];
  });
}

/** The source of `packages/domain/src/assistScreens.generated.ts`. */
export function generatedSource(entries: readonly AssistScreenEntry[]): string {
  return `/*
 * GENERATED from the web router by apps/web/src/assist/screens.ts — do not
 * edit. \`UPDATE_ASSIST_SCREENS=1 pnpm --filter @quiz/web test -- src/assist/screens\`
 * rewrites it; the test fails while it differs (ADR-080 P2b).
 */
import type { AssistScreenEntry } from "./assistScreens.js";

export const ASSIST_SCREENS: readonly AssistScreenEntry[] = ${JSON.stringify(entries, null, 2)};
`;
}
