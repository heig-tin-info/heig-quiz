import { useSyncExternalStore } from "react";

import { parsePath, routeToPath, type Route } from "./router";

/**
 * "View as student": the teacher UI switched off, so the app draws what a
 * student gets (ADR-018).
 *
 * Two things are persisted, and they belong together:
 *   - WHETHER the teacher is in student view, so a reload keeps it;
 *   - WHERE "Back to teacher view" lands. The banner used to send everybody
 *     to the teacher home, which is wrong for the walk this exists for: a
 *     teacher who entered from an evaluation wants that evaluation back. And
 *     it must survive a reload, because the student player is a page people
 *     reload.
 *
 * Module state behind a subscribable store, exactly like `theme.ts`, and for
 * the same reason: four surfaces read it (`App`, the account menu, the
 * command palette, the evaluation page) and a `useState` in each would make
 * three of them stale. Storage IS the state, so nothing goes stale behind a
 * test that clears `localStorage` either.
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

/** Whether the teacher is currently looking at the student UI. */
export function studentViewOn(): boolean {
  return localStorage.getItem(KEY) === "student";
}

/**
 * The route "Back to teacher view" goes to. A stored path that no longer
 * parses to anything is simply the teacher home, which is the honest answer
 * for "I do not know where you came from".
 */
export function studentViewReturn(): Route {
  const path = localStorage.getItem(RETURN_KEY);
  return path === null ? { view: "home" } : parsePath(path);
}

/**
 * Turns the student view on and remembers the way back. `returnTo` is the
 * teacher page the walk started from — the evaluation, for the button this
 * was built for.
 */
export function enterStudentView(returnTo: Route): void {
  localStorage.setItem(KEY, "student");
  localStorage.setItem(RETURN_KEY, routeToPath(returnTo));
  emit();
}

/** Turns it off and answers where the teacher should land. */
export function leaveStudentView(): Route {
  const back = studentViewReturn();
  localStorage.setItem(KEY, "teacher");
  localStorage.removeItem(RETURN_KEY);
  emit();
  return back;
}

export function useStudentView(): boolean {
  return useSyncExternalStore(subscribe, studentViewOn, studentViewOn);
}
