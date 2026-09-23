import { useSyncExternalStore } from "react";

import { parsePath, ROUTE_VIEWS, ROUTES, routeToPath, type Route } from "./router";

/**
 * "View as student": the teacher UI switched off, so the app draws what a
 * student gets (ADR-018, and its 2026-09-22 addendum).
 *
 * Two things are persisted, and they belong together:
 *   - WHETHER the teacher is in student view, so a reload keeps it;
 *   - WHERE "Back to teacher view" lands. The banner used to send everybody
 *     to the teacher home, which is wrong for the walk this exists for: a
 *     teacher who entered from an evaluation wants that evaluation back. And
 *     it must survive a reload, because the student player is a page people
 *     reload.
 *
 * `sessionStorage`, NOT `localStorage`: the view is a property of the WINDOW,
 * not of the browser. A teacher who launches an evaluation keeps the live
 * dashboard in one tab and takes their own test attempt in another, and with
 * a shared key the second tab dragged the first one into the student UI. A
 * session store survives the reloads of its own tab — which is what the walk
 * needs — and reaches no other tab.
 *
 * Module state behind a subscribable store, exactly like `theme.ts`, and for
 * the same reason: five surfaces read it (`App`, the frame's toggle, the
 * account menu, the command palette, the evaluation page) and a `useState` in
 * each would make four of them stale. Storage IS the state, so nothing goes
 * stale behind a test that clears `sessionStorage` either.
 */

const KEY = "quiz-view-as";
const RETURN_KEY = "quiz-view-as-return";

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the teacher is currently looking at the student UI, in THIS tab. */
export function studentViewOn(): boolean {
  return sessionStorage.getItem(KEY) === "student";
}

/**
 * The route "Back to teacher view" goes to. A stored path that no longer
 * parses to anything is simply the teacher home, which is the honest answer
 * for "I do not know where you came from".
 */
export function studentViewReturn(): Route {
  const path = sessionStorage.getItem(RETURN_KEY);
  return path === null ? { view: "home" } : parsePath(path);
}

/**
 * Turns the student view on and remembers the way back. `returnTo` is the
 * teacher page the walk started from — the evaluation, or the live dashboard
 * the toggle was flipped on.
 */
export function enterStudentView(returnTo: Route): void {
  sessionStorage.setItem(KEY, "student");
  sessionStorage.setItem(RETURN_KEY, routeToPath(returnTo));
  emit();
}

/** Turns it off and answers where the teacher should land. */
export function leaveStudentView(): Route {
  const back = studentViewReturn();
  sessionStorage.setItem(KEY, "teacher");
  sessionStorage.removeItem(RETURN_KEY);
  emit();
  return back;
}

export function useStudentView(): boolean {
  return useSyncExternalStore(subscribe, studentViewOn, studentViewOn);
}

/**
 * The routes a student (or a teacher in student view) actually has a screen
 * for: the entries of the route table (`router.ts`) marked `studentSafe`.
 * Everything else falls through to `StudentHome` — which is right — but it
 * used to render it UNDER the teacher URL, so a reload or a Back landed on
 * the same wrong address again (W20).
 */
export const STUDENT_ROUTES: ReadonlySet<Route["view"]> = new Set(
  ROUTE_VIEWS.filter((view) => ROUTES[view].studentSafe),
);

/**
 * Where flipping the switch to "student" lands, from the teacher page it was
 * flipped on.
 *
 * The two evaluation screens a teacher is on while a quiz is alive — the
 * configuration and the live dashboard — map to that evaluation's own student
 * route, so "launch it, then join it" is one click and not a hunt through the
 * student home. `/take/:id` is the route the SERVER routes: it answers the
 * lobby before the start and the player after, and it refuses with a screen
 * of its own when the teacher holds no seat or the evaluation is not open.
 *
 * Everything else lands on the student home: a grading panel and a results
 * table have no student twin that can be named without the reader's attempt
 * id, and guessing one would open the wrong person's page.
 */
export function studentRouteFor(route: Route): Route {
  if (route.view === "evaluation" || route.view === "live") {
    return { view: "attempt", evaluationId: route.id };
  }
  // Already a student page (settings, a feedback sheet, an attempt): staying
  // put is the answer, and it keeps the address bar honest.
  return STUDENT_ROUTES.has(route.view) ? route : { view: "home" };
}
