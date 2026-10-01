import { useCallback, useEffect, useRef, useState } from "react";

import { encodeJournalPath, safeJournalPath } from "@quiz/contracts";

/** The classroom's sections that live in `?tab=`; the others are routes of their own. */
export type ClassroomQueryTab = "roster" | "evaluations" | "drill";

/**
 * Minimal history-backed router: every in-app navigation pushes a real URL,
 * so the browser (and mouse) back/forward buttons work, and deep links
 * survive a reload (the server falls back to index.html for non-API GETs).
 */
export type Route =
  | { view: "home" }
  | { view: "settings" }
  /**
   * `tab`: the Administration tab to open on (a system alert opens the
   * System status). Written into `?tab=` only: `parsePath` never reads it
   * back, the page reads it off the query string, like the classroom's.
   */
  | { view: "admin"; tab?: AdminTab }
  /**
   * One course: its classrooms, its linked pools and its evaluation
   * templates (F-ORG-12). The Courses row stays lit: it is a page of that
   * section, as a pool is one of the pools'.
   */
  | { view: "course"; id: string }
  /**
   * One evaluation template of a course, edited in place (F-EVAL-25). A page
   * of its course, so the Courses row stays lit too.
   */
  | { view: "template"; id: string }
  /**
   * `tab`: the section to open on (the launch checklist's "Roster" link,
   * #152), carried in `?tab=` like the page's own tabs; `parsePath` never
   * sees it, the page reads it off the query string. Without one, the
   * classroom opens on its evaluations.
   */
  | { view: "classroom"; id: string; tab?: ClassroomQueryTab }
  /*
   * The pages of the classroom merge (ADR-035, `docs/merge/05-web.md` §5.2),
   * each behind `CLASSROOM_PAGES` (below) until its screen ships.
   */
  /**
   * The student's Courses (F-ORG-14, D07): their classrooms, each card opening
   * the classroom's page. `/courses` alone; `/courses/:id` is a teacher's course.
   */
  | { view: "studentCourses" }
  /**
   * The student's Grades (F-ORG-14, F-RES-04): their finished work, by
   * classroom, `/grades`. The bottom bar's and the sidebar's Grades slot.
   */
  | { view: "studentGrades" }
  /** The teacher classroom's Settings tab (F-ORG-13, D24): GitHub, Journal, rename… */
  | { view: "classroomSettings"; id: string }
  /**
   * The classroom's journal, both roles (F-JRN-07): `path` is the page's
   * journal path, DECODED (`20-semaine 2/10-tableaux.md`), absent for the
   * journal's home. The address encodes each segment on its own.
   */
  | { view: "classroomJournal"; id: string; path?: string }
  /** The classroom's Grades tab: the teacher's export, the student's table (§5.2). */
  | { view: "classroomGrades"; id: string }
  /** One project (M3-12), and its groups. Declared: no screen reaches them yet. */
  | { view: "project"; id: string }
  | { view: "projectGroups"; id: string }
  /**
   * Every evaluation and poll the teacher manages, across classrooms (#190):
   * a table, cards or a week-by-week schedule, "Live now" on top.
   */
  | { view: "activities" }
  /** The teacher's question pools (WP7). */
  | { view: "pools" }
  | { view: "pool"; id: string }
  /** The categories of one pool, as a tree to rename, move and reorder. */
  | { view: "poolCategories"; id: string }
  /**
   * `from`: the evaluation the editor was opened from (issue #127), carried
   * in `?from=` so the way back survives a reload; `fromTemplate`, likewise,
   * a template (F-EVAL-25), in `?fromTemplate=`; `fromGrading` and `item`,
   * the grading screen of an evaluation and the question it was on (ADR-044,
   * addendum). The editor reads them off the query string
   * (`useSearchParam`); `parsePath` never sees them.
   */
  | ({ view: "question"; id: string } & QuestionOrigin)
  /**
   * What a student would see for ONE question, in a page of its own
   * (docs/spec/08 §8.2, "See what the student sees"). The editor opens it in
   * a new tab, so the draft the teacher is writing stays where it was.
   */
  | { view: "questionPreview"; id: string }
  // WP9: student player
  /** The student's attempt: the server decides between the lobby and the player. */
  | { view: "attempt"; evaluationId: string }
  // WP8: evaluation + dashboard
  /** The three-step configuration; the step lives in `?step=`. */
  | { view: "evaluation"; id: string }
  /** The live grid of one evaluation. */
  | { view: "live"; id: string }
  /**
   * The teacher walks the whole evaluation as a student, statelessly, and
   * gets the full correction (issue #75). Opened in a new tab from the
   * evaluation page, so the configuration stays open beside it.
   */
  | { view: "evaluationPreview"; id: string }
  /** The poll launcher: pick or write the question, then the wall (F-LIVE-13). */
  | { view: "polls" }
  /** The projection of a poll: the question, the tally, the QR (F-LIVE-14). */
  | { view: "poll"; id: string }
  /** A participant joining a poll by its session code — with or without an account. */
  | { view: "join"; code: string }
  /**
   * The OAuth consent page (ADR-023): an MCP client such as claude.ai asks to
   * act for the teacher. `id` is the pending request, or `invalid` when the
   * server refused the request before it could be trusted (`?reason=`).
   */
  | { view: "oauthConsent"; id: string }
  /**
   * The Teams link page (ADR-030): the HEIG Quiz tab in Teams opens it in the
   * browser with the pending link's one-time token in `?token=`, which the
   * page reads itself.
   */
  | { view: "teamsLink" }
  /**
   * The HEIG Quiz tab INSIDE Teams (ADR-030): rendered with no session at
   * all — Teams frames it, and the platform's cookies do not follow.
   */
  | { view: "teamsTab" }
  /**
   * A kiosk station's screen (ADR-051 §7): a school Chromebook locked on
   * `/kiosk` attests itself, then shows its code and QR until a phone pairs
   * it. Drawn with no session and without waiting on `/me` (App.tsx).
   */
  | { view: "kiosk" }
  /**
   * The phone's half of the pairing (ADR-051 §7): the code of the station in
   * front of the student, from the QR (`?code=`, which the page reads itself)
   * or typed; then the exam to open there.
   */
  | { view: "pair" }
  // WP10: grading + results
  /**
   * The teacher's grading panel for one evaluation; `item`, the question it
   * opens on, travels in `?item=` (the panel reads and keeps it there).
   */
  | { view: "grading"; evaluationId: string; item?: string }
  /** The teacher's results table for one evaluation. */
  | { view: "results"; evaluationId: string }
  /** The correction of a graded evaluation, projected in class (F-RES-03, ADR-033). */
  | { view: "correction"; evaluationId: string }
  /** The student's own feedback on one finished attempt (the ONE such page). */
  | { view: "feedback"; attemptId: string }
  /** The student's drill (ADR-041, #317): today's session and the classrooms it draws from. */
  | { view: "drill" }
  /** Development only: the gallery of the shared primitives (App.tsx gates it). */
  | { view: "devUi" };

/**
 * The query parameters that tell the question editor where it was opened
 * from, and on which item: one list, which the route writes in one loop and
 * the editor reads (`QuestionEditor`'s `ORIGINS`).
 */
export const QUESTION_ORIGIN_PARAMS = ["from", "fromTemplate", "fromGrading", "item"] as const;
export type QuestionOrigin = Partial<Record<(typeof QUESTION_ORIGIN_PARAMS)[number], string>>;

/** The one member of `Route` whose `view` is `V`. */
export type RouteOf<V extends Route["view"]> = Extract<Route, { view: V }>;

/**
 * The teacher sidebar's sections (`Shell`'s `Nav`): the row that stays lit
 * while a view is up. The student's sidebar is lit by `bottomSlot` instead.
 */
export type NavSection = "home" | "activities" | "pools" | "polls" | "admin";

/**
 * The slots of the student's bottom bar on a phone (`student/bottomNavSlots.ts`,
 * #191), which the student's desktop sidebar mirrors.
 */
export type BottomSlotId = "activities" | "courses" | "drill" | "grades" | "profile";

/**
 * Everything the app knows about one view, in one place: how it is written
 * as a path, how a path is recognized as it, whether a student has a screen
 * for it, and where it sits in the navigation. `path` and `match` are methods (not arrow properties) so a
 * spec for one view is usable where a spec for any view is expected.
 */
export interface RouteSpec<V extends Route["view"]> {
  path(route: RouteOf<V>): string;
  /** The route this path names, or `null` when it is not this view's. */
  match(parts: string[]): RouteOf<V> | null;
  /**
   * A student (or a teacher in student view) has a screen for this view.
   * Everything else falls through to the student home (`studentView.ts`).
   */
  studentSafe: boolean;
  /** The sidebar row lit while this view is up; absent when none is. */
  section?: NavSection;
  /**
   * The student bottom bar's slot lit while this view is up. A view without
   * one has no bar (DESIGN.md, "The student's bottom bar").
   */
  bottomSlot?: BottomSlotId;
  /**
   * Present on the teacher screens of ONE evaluation that link to each other
   * (the palette's "grading" and "results" entries): the evaluation's id.
   */
  evaluationId?(route: RouteOf<V>): string;
  /**
   * A route of the classroom merge whose screen is not built yet, gated by
   * `CLASSROOM_PAGES` (below): `parsePath` skips it while the flag is off, so
   * a production address reads exactly as it did before it. Dropped by the PR
   * that ships the screen.
   */
  preview?: true;
}

/**
 * The gate of the classroom merge's routes (ADR-035, `docs/merge/05-web.md`
 * §5.1–§5.2) whose routes exist before their screens do: the classroom's
 * Grades tab and the project pages. Each renders a placeholder
 * (`ComingSoon`) until its task ships the real screen (M5-04, M3-12).
 *
 * Off in a production build: the `preview` routes do not parse. On in the
 * browser mock (`VITE_MOCK=1`), and wherever `VITE_CLASSROOM_PAGES=1` is set
 * at build time. The student's Courses and classroom page left it with M5-02,
 * the classroom's Settings with M2-07, the Journal (route and both tabs)
 * with M4-05 — on a platform without Quiz's App its API answers 404 and no
 * Journal tab is drawn.
 */
export const CLASSROOM_PAGES =
  import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_CLASSROOM_PAGES === "1";

/** The tabs of the Administration page, in their order (`AdminPanel.tsx`). */
export const ADMIN_TABS = ["people", "system", "tasks", "llm"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** A view whose path is one fixed segment (`/settings`, `/polls`, …), whatever follows it. */
function fixed<V extends Route["view"]>(
  segment: string,
  route: RouteOf<V>,
  studentSafe = false,
): RouteSpec<V> {
  return {
    path: () => `/${segment}`,
    match: ([head]) => (head === segment ? route : null),
    studentSafe,
  };
}

type EvaluationTailView =
  | "live"
  | "poll"
  | "grading"
  | "results"
  | "correction"
  | "evaluationPreview";

/** `/evaluations/:id/<tail>`: one of the screens that hang off an evaluation. */
function evaluationTail<V extends EvaluationTailView>(
  tail: string,
  make: (id: string) => RouteOf<V>,
  extra: NoInfer<Pick<RouteSpec<V>, "section" | "evaluationId">> = {},
): RouteSpec<V> {
  return {
    path: (route) => `/evaluations/${evaluationIdOf(route)}/${tail}`,
    match: ([head, id, rest]) => (head === "evaluations" && id && rest === tail ? make(id) : null),
    studentSafe: false,
    ...extra,
  };
}

/** The evaluation a screen of the evaluation family belongs to. */
function evaluationIdOf(route: RouteOf<EvaluationTailView | "evaluation">): string {
  return "id" in route ? route.id : route.evaluationId;
}

/**
 * The route table: ONE entry per member of `Route`. The mapped type makes a
 * view added to the union and forgotten here a compile error, and
 * `router.test.ts` walks the table against the union as well.
 *
 * `parsePath` asks the entries IN THIS ORDER and takes the first match. Most
 * are told apart by their first segment and could sit anywhere; order
 * matters in a family with a catch-all, the evaluation's first: `evaluation`
 * accepts ANY tail after the id — an unknown tail lands on the configuration screen
 * rather than on the home — so it comes after `live`, `poll`, `grading`,
 * `results` and `evaluationPreview`. The classroom's tabs and the project's
 * groups precede `classroom` and `project` for the same reason. `home`
 * matches nothing: it is the fallback.
 */
export const ROUTES: { readonly [V in Route["view"]]: RouteSpec<V> } = {
  home: {
    path: () => "/",
    match: () => null,
    studentSafe: true,
    section: "home",
    bottomSlot: "activities",
  },
  settings: { ...fixed("settings", { view: "settings" }, true), bottomSlot: "profile" },
  admin: {
    ...fixed("admin", { view: "admin" }),
    path: (r) => `/admin${r.tab ? `?tab=${r.tab}` : ""}`,
    section: "admin",
  },
  course: {
    path: (r) => `/courses/${r.id}`,
    match: ([head, id]) => (head === "courses" && id ? { view: "course", id } : null),
    studentSafe: false,
    section: "home",
  },
  template: {
    path: (r) => `/templates/${r.id}`,
    match: ([head, id]) => (head === "templates" && id ? { view: "template", id } : null),
    studentSafe: false,
    section: "home",
  },
  // F-ORG-14 (D07): `/courses` alone, the student's classrooms. A teacher's
  // Courses is the home; `/courses/:id` is one course (above). A student's
  // sidebar lights its Courses row through the slot.
  studentCourses: {
    path: () => "/courses",
    match: ([head, id]) => (head === "courses" && !id ? { view: "studentCourses" } : null),
    studentSafe: true,
    bottomSlot: "courses",
  },
  // F-ORG-14, F-RES-04: the student's finished work, every classroom's. A
  // teacher's UI has no page of its own here; it gets the home.
  studentGrades: { ...fixed("grades", { view: "studentGrades" }, true), bottomSlot: "grades" },
  // The classroom's tabs that are routes (§5.2). Before `classroom`, which
  // takes any tail after the id.
  classroomSettings: {
    path: (r) => `/classrooms/${r.id}/settings`,
    match: ([head, id, tail]) =>
      head === "classrooms" && id && tail === "settings" ? { view: "classroomSettings", id } : null,
    studentSafe: false,
  },
  classroomJournal: {
    path: (r) => `/classrooms/${r.id}/journal${r.path ? `/${encodeJournalPath(r.path)}` : ""}`,
    match: ([head, id, tail, ...rest]) => {
      if (head !== "classrooms" || !id || tail !== "journal") return null;
      const path = journalPathOf(rest);
      return path === undefined ? { view: "classroomJournal", id } : { view: "classroomJournal", id, path };
    },
    studentSafe: true,
    bottomSlot: "courses",
  },
  classroomGrades: {
    path: (r) => `/classrooms/${r.id}/grades`,
    match: ([head, id, tail]) =>
      head === "classrooms" && id && tail === "grades" ? { view: "classroomGrades", id } : null,
    studentSafe: true,
    bottomSlot: "courses",
    preview: true,
  },
  // Role-dispatched (F-ORG-15): the teacher's classroom, or the student's page
  // of it (M5-02), whose Activities tab it is.
  classroom: {
    path: (r) => `/classrooms/${r.id}${r.tab ? `?tab=${r.tab}` : ""}`,
    match: ([head, id]) => (head === "classrooms" && id ? { view: "classroom", id } : null),
    studentSafe: true,
    bottomSlot: "courses",
  },
  // M3-12: declared, no screen links to them yet. `projectGroups` first:
  // `project` takes any tail after the id.
  projectGroups: {
    path: (r) => `/projects/${r.id}/groups`,
    match: ([head, id, tail]) =>
      head === "projects" && id && tail === "groups" ? { view: "projectGroups", id } : null,
    studentSafe: false,
    section: "activities",
    preview: true,
  },
  project: {
    path: (r) => `/projects/${r.id}`,
    match: ([head, id]) => (head === "projects" && id ? { view: "project", id } : null),
    studentSafe: false,
    section: "activities",
    preview: true,
  },
  activities: { ...fixed("activities", { view: "activities" }), section: "activities" },
  pools: {
    path: () => "/pools",
    match: ([head, id]) => (head === "pools" && !id ? { view: "pools" } : null),
    studentSafe: false,
    section: "pools",
  },
  // Before `pool`, which takes any tail after the id.
  poolCategories: {
    path: (r) => `/pools/${r.id}/categories`,
    match: ([head, id, tail]) =>
      head === "pools" && id && tail === "categories" ? { view: "poolCategories", id } : null,
    studentSafe: false,
    section: "pools",
  },
  pool: {
    path: (r) => `/pools/${r.id}`,
    match: ([head, id]) => (head === "pools" && id ? { view: "pool", id } : null),
    studentSafe: false,
    section: "pools",
  },
  polls: { ...fixed("polls", { view: "polls" }), section: "polls" },
  // `/questions/:id/preview` is the student preview; every other tail is the
  // editor itself (its tab lives in the query string, not in the path).
  question: {
    path: (r) => {
      const query = new URLSearchParams();
      for (const name of QUESTION_ORIGIN_PARAMS) {
        const value = r[name];
        if (value) query.set(name, value);
      }
      const q = query.toString();
      return `/questions/${r.id}${q ? `?${q}` : ""}`;
    },
    match: ([head, id, tail]) =>
      head === "questions" && id && tail !== "preview" ? { view: "question", id } : null,
    studentSafe: false,
    // A question is read inside its pool, not beside it.
    section: "pools",
  },
  questionPreview: {
    path: (r) => `/questions/${r.id}/preview`,
    match: ([head, id, tail]) =>
      head === "questions" && id && tail === "preview" ? { view: "questionPreview", id } : null,
    studentSafe: false,
  },
  // WP9: student player
  attempt: {
    path: (r) => `/take/${r.evaluationId}`,
    match: ([head, evaluationId]) =>
      head === "take" && evaluationId ? { view: "attempt", evaluationId } : null,
    studentSafe: true,
  },
  // A poll's session code, as printed under the QR. Upper-cased so a code
  // typed by hand on a phone survives the keyboard's habits.
  join: {
    path: (r) => `/p/${r.code}`,
    match: ([head, code]) =>
      head === "p" && code ? { view: "join", code: code.toUpperCase() } : null,
    studentSafe: true,
  },
  // ADR-023: reached from `/app/oauth/authorize`, signed in or not; a student
  // lands on it too and is told it is a teacher's page.
  oauthConsent: {
    path: (r) => `/oauth/authorize/${r.id}`,
    match: ([head, tail, id]) =>
      head === "oauth" && tail === "authorize" && id ? { view: "oauthConsent", id } : null,
    studentSafe: true,
  },
  // ADR-030: opened from the HEIG Quiz tab in Teams, signed in or not, by any role.
  teamsLink: {
    path: () => "/teams/link",
    match: ([head, tail]) => (head === "teams" && tail === "link" ? { view: "teamsLink" } : null),
    studentSafe: true,
  },
  // ADR-030: the tab itself, `/teams` exactly — the manifest's `contentUrl`.
  // `apps/api/src/csp.ts` keys the Teams framing on this exact path.
  teamsTab: {
    path: () => "/teams",
    match: (parts) => (parts.length === 1 && parts[0] === "teams" ? { view: "teamsTab" } : null),
    studentSafe: true,
  },
  // ADR-051 §7: the station's screen, `/kiosk` exactly — the kiosk policy's
  // start URL — and the phone's pairing page.
  kiosk: {
    path: () => "/kiosk",
    match: (parts) => (parts.length === 1 && parts[0] === "kiosk" ? { view: "kiosk" } : null),
    studentSafe: true,
  },
  pair: fixed("pair", { view: "pair" }, true),
  // WP10: the student's feedback on one attempt — the ONE student results page.
  feedback: {
    path: (r) => `/attempts/${r.attemptId}/feedback`,
    match: ([head, attemptId, tail]) =>
      head === "attempts" && attemptId && tail === "feedback"
        ? { view: "feedback", attemptId }
        : null,
    studentSafe: true,
    bottomSlot: "grades",
  },
  // ADR-041 (#317): the student's drill, the centre slot of the bottom bar.
  drill: {
    ...fixed("drill", { view: "drill" }, true),
    bottomSlot: "drill",
  },
  // WP8 + WP10: ONE place decides what follows an evaluation id, so a new
  // tail is an entry here and nowhere else.
  live: evaluationTail("live", (id) => ({ view: "live", id }), { evaluationId: evaluationIdOf }),
  evaluationPreview: evaluationTail("preview", (id) => ({ view: "evaluationPreview", id })),
  // The projection IS the poll: the launcher's row stays lit while it is up.
  poll: evaluationTail("poll", (id) => ({ view: "poll", id }), { section: "polls" }),
  grading: {
    ...evaluationTail("grading", (evaluationId) => ({ view: "grading", evaluationId }), {
      evaluationId: evaluationIdOf,
    }),
    path: (r) =>
      `/evaluations/${r.evaluationId}/grading${r.item ? `?item=${encodeURIComponent(r.item)}` : ""}`,
  },
  results: evaluationTail("results", (evaluationId) => ({ view: "results", evaluationId }), {
    evaluationId: evaluationIdOf,
  }),
  // The results' Questions tab on a beamer: like the poll, it links to none
  // of the screens above.
  correction: evaluationTail("correction", (evaluationId) => ({ view: "correction", evaluationId })),
  // After the tails above: this one takes whatever tail is left.
  evaluation: {
    path: (r) => `/evaluations/${r.id}`,
    match: ([head, id]) => (head === "evaluations" && id ? { view: "evaluation", id } : null),
    studentSafe: false,
    evaluationId: evaluationIdOf,
  },
  // Parsed in every build so the route is one pure function; App.tsx is what
  // refuses to render it outside development.
  devUi: {
    path: () => "/dev/ui",
    match: ([head, sub]) => (head === "dev" && sub === "ui" ? { view: "devUi" } : null),
    studentSafe: false,
  },
};

/** Every view, in the order `parsePath` asks them. */
export const ROUTE_VIEWS = Object.keys(ROUTES) as Route["view"][];

/**
 * The spec of `view`, typed for any route. The one cast of the table: the
 * compiler cannot correlate `r.view` with the member of `Route` it selects.
 */
function specOf(view: Route["view"]): RouteSpec<Route["view"]> {
  return ROUTES[view] as RouteSpec<Route["view"]>;
}

export function routeToPath(r: Route): string {
  return specOf(r.view).path(r);
}

/** The bottom bar's slot `route` lights, or `null` when the view has no bar. */
export function bottomSlotOf(route: Route): BottomSlotId | null {
  return specOf(route.view).bottomSlot ?? null;
}

/** The sidebar section `route` belongs to, or `null` when it lights no row. */
export function sectionOf(route: Route): NavSection | null {
  return specOf(route.view).section ?? null;
}

/**
 * The evaluation whose teacher screens `route` is one of (configuration,
 * live dashboard, grading, results), or `null` anywhere else — the poll
 * projection included: it hangs off an evaluation but links to none of them.
 */
export function evaluationInView(route: Route): string | null {
  return specOf(route.view).evaluationId?.(route) ?? null;
}

/** One segment of an address, decoded; a malformed escape is kept as written (the reader then finds no such page). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The journal path the segments after `/journal/` name, or undefined — the
 * journal's home — when they name none the journal's routes would serve
 * (`safeJournalPath`, N-SEC-15): a climb, an escaped dot or slash, a control
 * character, a path over the cap. A segment holding an encoded slash is
 * refused outright rather than read as two segments.
 */
function journalPathOf(segments: string[]): string | undefined {
  if (segments.length === 0 || segments.some((s) => /%2f/i.test(s))) return undefined;
  return safeJournalPath(segments.map(decodeSegment).join("/")) ?? undefined;
}

/**
 * The route a path names. Split on `/`, empty segments dropped: a trailing
 * slash, or a doubled one, names the same page. Segments reach `match` as
 * the address wrote them, still encoded; a route whose segment is free text
 * (the journal's path) decodes it itself.
 */
export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  for (const view of ROUTE_VIEWS) {
    if (ROUTES[view].preview && !CLASSROOM_PAGES) continue;
    const route = specOf(view).match(parts);
    if (route) return route;
  }
  return { view: "home" };
}

/**
 * How a screen moves the app. `replace` swaps the current history entry
 * instead of pushing one: a page that only ever forwards (the player of a
 * finished retake attempt, which goes to the score) must not be a Back
 * target that bounces the student forward again.
 */
export type Navigate = (r: Route, options?: { replace?: boolean }) => void;

/**
 * What asks before the app leaves a screen that holds unsaved work (the
 * journal's editor, M4-06): resolves true to leave. One at a time — the
 * screen on view — and null while nothing is at stake.
 */
export type LeaveGuard = () => Promise<boolean>;
let leaveGuard: LeaveGuard | null = null;

/**
 * Asks `ask` before any navigation away while `dirty`: an in-app link or
 * `navigate` (held until it answers), Back and Forward (undone, then redone
 * once it answers yes), and a reload or a closed tab (the browser's own
 * prompt, which is all a page may do there).
 */
export function useLeaveGuard(dirty: boolean, ask: LeaveGuard): void {
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (!dirty) return;
    const guard: LeaveGuard = () => askRef.current();
    leaveGuard = guard;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      if (leaveGuard === guard) leaveGuard = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);
}

/**
 * Fired by `useSearchParam` right after it rewrote the query string, and by
 * `navigate` once it moved. `history.replaceState` and `pushState` emit no
 * `popstate`, so two hooks reading the same parameter — the sidebar's
 * category tree and the pool page it drives — each kept their own copy and
 * never saw the other's write. One event, dispatched on `window`, is what
 * makes the query string the single source of truth.
 */
const SEARCH_PARAM_EVENT = "quiz:searchparam";

/** The address on view, query included, as the router last showed it. */
const here = () => window.location.pathname + window.location.search;

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const shown = useRef(here());
  useEffect(() => {
    const onPop = () => {
      const guard = leaveGuard;
      if (guard === null) {
        shown.current = here();
        setRoute(parsePath(window.location.pathname));
        return;
      }
      // The browser has moved already: put the page back, then ask.
      window.history.pushState(null, "", shown.current);
      void guard().then((ok) => {
        if (!ok) return;
        leaveGuard = null;
        window.history.back();
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback<Navigate>((r, options) => {
    const path = routeToPath(r);
    const go = () => {
      // The whole address, query included: a click on the page on view
      // drops its `?tab=` too, and lands where the route says.
      if (path !== here()) {
        if (options?.replace) window.history.replaceState(null, "", path);
        else window.history.pushState(null, "", path);
        // No `popstate` either: without this, a page that stays mounted (one
        // classroom to the next) kept the old address's `?tab=`.
        window.dispatchEvent(new Event(SEARCH_PARAM_EVENT));
      }
      shown.current = here();
      setRoute(r);
    };
    const guard = leaveGuard;
    if (guard === null || path === window.location.pathname) {
      go();
      return;
    }
    void guard().then((ok) => {
      if (!ok) return;
      leaveGuard = null;
      go();
    });
  }, []);
  return [route, navigate];
}

/**
 * One query-string parameter as state (tabs inside a page, the selected
 * category of a pool). Reading survives a reload; writing replaces the entry
 * so Back still leaves the page.
 *
 * It listens to `popstate` — Back and Forward move between pages that carry a
 * `?tab=` of their own, and without this the value stayed on whatever the
 * previous page had selected — and to `SEARCH_PARAM_EVENT`, so every instance
 * on the screen re-reads the URL whenever any of them writes it.
 */
export function useSearchParam(name: string, fallback: string): [string, (v: string) => void] {
  const read = useCallback(
    () => new URLSearchParams(window.location.search).get(name) ?? fallback,
    [name, fallback],
  );
  const [value, setValue] = useState(read);
  useEffect(() => {
    const sync = () => setValue(read());
    window.addEventListener("popstate", sync);
    window.addEventListener(SEARCH_PARAM_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(SEARCH_PARAM_EVENT, sync);
    };
  }, [read]);
  const set = useCallback(
    (v: string) => {
      const params = new URLSearchParams(window.location.search);
      if (v === fallback) params.delete(name);
      else params.set(name, v);
      const q = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
      setValue(v);
      // After the URL changed, never before: a listener reads `location`.
      window.dispatchEvent(new Event(SEARCH_PARAM_EVENT));
    },
    [name, fallback],
  );
  return [value, set];
}
