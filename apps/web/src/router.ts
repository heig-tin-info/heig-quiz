import { useCallback, useEffect, useState } from "react";

/**
 * Minimal history-backed router: every in-app navigation pushes a real URL,
 * so the browser (and mouse) back/forward buttons work, and deep links
 * survive a reload (the server falls back to index.html for non-API GETs).
 */
export type Route =
  | { view: "home" }
  | { view: "settings" }
  | { view: "admin" }
  | { view: "classroom"; id: string }
  /** The teacher's question pools (WP7). */
  | { view: "pools" }
  | { view: "pool"; id: string }
  /** The categories of one pool, as a tree to rename, move and reorder. */
  | { view: "poolCategories"; id: string }
  | { view: "question"; id: string }
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
  // WP10: grading + results
  /** The teacher's grading panel for one evaluation. */
  | { view: "grading"; evaluationId: string }
  /** The teacher's results table for one evaluation. */
  | { view: "results"; evaluationId: string }
  /** The student's own feedback on one finished attempt (the ONE such page). */
  | { view: "feedback"; attemptId: string }
  /** Development only: the gallery of the shared primitives (App.tsx gates it). */
  | { view: "devUi" };

/** The one member of `Route` whose `view` is `V`. */
export type RouteOf<V extends Route["view"]> = Extract<Route, { view: V }>;

/** The sidebar sections (`Shell`'s `Nav`): the row that stays lit while a view is up. */
export type NavSection = "home" | "pools" | "polls" | "admin";

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
   * Present on the teacher screens of ONE evaluation that link to each other
   * (the palette's "grading" and "results" entries): the evaluation's id.
   */
  evaluationId?(route: RouteOf<V>): string;
}

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

type EvaluationTailView = "live" | "poll" | "grading" | "results" | "evaluationPreview";

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
 * are told apart by their first segment and could sit anywhere; the one
 * place order matters is the evaluation family: `evaluation` accepts ANY
 * tail after the id — an unknown tail lands on the configuration screen
 * rather than on the home — so it comes after `live`, `poll`, `grading`,
 * `results` and `evaluationPreview`. `home` matches nothing: it is the fallback.
 */
export const ROUTES: { readonly [V in Route["view"]]: RouteSpec<V> } = {
  home: { path: () => "/", match: () => null, studentSafe: true, section: "home" },
  settings: fixed("settings", { view: "settings" }, true),
  admin: { ...fixed("admin", { view: "admin" }), section: "admin" },
  classroom: {
    path: (r) => `/classrooms/${r.id}`,
    match: ([head, id]) => (head === "classrooms" && id ? { view: "classroom", id } : null),
    studentSafe: false,
  },
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
    path: (r) => `/questions/${r.id}`,
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
  // WP10: the student's feedback on one attempt — the ONE student results page.
  feedback: {
    path: (r) => `/attempts/${r.attemptId}/feedback`,
    match: ([head, attemptId, tail]) =>
      head === "attempts" && attemptId && tail === "feedback"
        ? { view: "feedback", attemptId }
        : null,
    studentSafe: true,
  },
  // WP8 + WP10: ONE place decides what follows an evaluation id, so a new
  // tail is an entry here and nowhere else.
  live: evaluationTail("live", (id) => ({ view: "live", id }), { evaluationId: evaluationIdOf }),
  evaluationPreview: evaluationTail("preview", (id) => ({ view: "evaluationPreview", id })),
  // The projection IS the poll: the launcher's row stays lit while it is up.
  poll: evaluationTail("poll", (id) => ({ view: "poll", id }), { section: "polls" }),
  grading: evaluationTail("grading", (evaluationId) => ({ view: "grading", evaluationId }), {
    evaluationId: evaluationIdOf,
  }),
  results: evaluationTail("results", (evaluationId) => ({ view: "results", evaluationId }), {
    evaluationId: evaluationIdOf,
  }),
  // After the four tails above: this one takes whatever tail is left.
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

export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  for (const view of ROUTE_VIEWS) {
    const route = specOf(view).match(parts);
    if (route) return route;
  }
  return { view: "home" };
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((r: Route) => {
    const path = routeToPath(r);
    if (path !== window.location.pathname) {
      window.history.pushState(null, "", path);
    }
    setRoute(r);
  }, []);
  return [route, navigate];
}

/**
 * Fired by `useSearchParam` right after it rewrote the query string.
 * `history.replaceState` emits no `popstate`, so two hooks reading the same
 * parameter — the sidebar's category tree and the pool page it drives — each
 * kept their own copy and never saw the other's write. One event, dispatched
 * on `window`, is what makes the query string the single source of truth.
 */
const SEARCH_PARAM_EVENT = "quiz:searchparam";

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
