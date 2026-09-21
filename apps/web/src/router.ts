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
  | { view: "question"; id: string }
  // WP9: student player
  /** The student's attempt: the server decides between the lobby and the player. */
  | { view: "attempt"; evaluationId: string }
  // WP8: evaluation + dashboard
  /** The three-step configuration; the step lives in `?step=`. */
  | { view: "evaluation"; id: string }
  /** The live grid of one evaluation. */
  | { view: "live"; id: string }
  /** The projection of a poll: the question, the tally, the QR (F-LIVE-14). */
  | { view: "poll"; id: string }
  /** A participant joining a poll by its session code — with or without an account. */
  | { view: "join"; code: string }
  // WP10: grading + results
  /** The teacher's grading panel for one evaluation. */
  | { view: "grading"; evaluationId: string }
  /** The teacher's results table for one evaluation. */
  | { view: "results"; evaluationId: string }
  /** The student's own feedback on one finished attempt (the ONE such page). */
  | { view: "feedback"; attemptId: string }
  /** Development only: the gallery of the shared primitives (App.tsx gates it). */
  | { view: "devUi" };

export function routeToPath(r: Route): string {
  switch (r.view) {
    case "home":
      return "/";
    case "settings":
      return "/settings";
    case "admin":
      return "/admin";
    case "classroom":
      return `/classrooms/${r.id}`;
    case "pools":
      return "/pools";
    case "pool":
      return `/pools/${r.id}`;
    case "question":
      return `/questions/${r.id}`;
    // WP9: student player
    case "attempt":
      return `/take/${r.evaluationId}`;
    // WP8: evaluation + dashboard
    case "evaluation":
      return `/evaluations/${r.id}`;
    case "live":
      return `/evaluations/${r.id}/live`;
    case "poll":
      return `/evaluations/${r.id}/poll`;
    case "join":
      return `/p/${r.code}`;
    // WP10: grading + results
    case "grading":
      return `/evaluations/${r.evaluationId}/grading`;
    case "results":
      return `/evaluations/${r.evaluationId}/results`;
    case "feedback":
      return `/attempts/${r.attemptId}/feedback`;
    case "devUi":
      return "/dev/ui";
  }
}

export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "admin") return { view: "admin" };
  if (parts[0] === "classrooms" && parts[1]) return { view: "classroom", id: parts[1] };
  if (parts[0] === "pools") return parts[1] ? { view: "pool", id: parts[1] } : { view: "pools" };
  if (parts[0] === "questions" && parts[1]) return { view: "question", id: parts[1] };
  // WP9: student player
  if (parts[0] === "take" && parts[1]) return { view: "attempt", evaluationId: parts[1] };
  // A poll's session code, as printed under the QR. Upper-cased so a code
  // typed by hand on a phone survives the keyboard's habits.
  if (parts[0] === "p" && parts[1]) return { view: "join", code: parts[1].toUpperCase() };
  // WP10: the student's feedback on one attempt — the ONE student results page.
  if (parts[0] === "attempts" && parts[1] && parts[2] === "feedback")
    return { view: "feedback", attemptId: parts[1] };
  // WP8 + WP10: ONE place decides what follows an evaluation id, so a new
  // tail is added here and nowhere else. `evaluation` is the fallback: an
  // unknown tail lands on the configuration screen rather than on the home.
  if (parts[0] === "evaluations" && parts[1]) {
    switch (parts[2]) {
      case "live":
        return { view: "live", id: parts[1] };
      case "poll":
        return { view: "poll", id: parts[1] };
      case "grading":
        return { view: "grading", evaluationId: parts[1] };
      case "results":
        return { view: "results", evaluationId: parts[1] };
      default:
        return { view: "evaluation", id: parts[1] };
    }
  }
  // Parsed in every build so the route is one pure function; App.tsx is what
  // refuses to render it outside development.
  if (parts[0] === "dev" && parts[1] === "ui") return { view: "devUi" };
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
export const SEARCH_PARAM_EVENT = "quiz:searchparam";

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
