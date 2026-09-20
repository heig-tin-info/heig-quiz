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
  /** The student's own feedback on a finished attempt. */
  | { view: "studentResults"; attemptId: string }
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
    case "studentResults":
      return `/results/${r.attemptId}`;
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
  if (parts[0] === "results" && parts[1]) return { view: "studentResults", attemptId: parts[1] };
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
 * One query-string parameter as state (tabs inside a page). Reading survives
 * a reload; writing replaces the entry so Back still leaves the page.
 *
 * It still listens to `popstate`: Back and Forward move between pages that
 * carry a `?tab=` of their own, and without this the value stayed on whatever
 * the previous page had selected.
 */
export function useSearchParam(name: string, fallback: string): [string, (v: string) => void] {
  const read = useCallback(
    () => new URLSearchParams(window.location.search).get(name) ?? fallback,
    [name, fallback],
  );
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);
  const set = useCallback(
    (v: string) => {
      const params = new URLSearchParams(window.location.search);
      if (v === fallback) params.delete(name);
      else params.set(name, v);
      const q = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
      setValue(v);
    },
    [name, fallback],
  );
  return [value, set];
}
