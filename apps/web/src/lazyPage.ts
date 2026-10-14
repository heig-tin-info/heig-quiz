import { lazy, type ComponentType } from "react";

import { build } from "./realtime/build";
import { attemptAt } from "./router";

/** The address this tab reloaded once for a page's missing chunk. */
const RELOADED = "quiz:build-reload";

/**
 * A page whose chunk is gone while this screen may not reload by itself (an
 * attempt, a confined session, a write in flight): `CrashBoundary` offers the
 * reload instead (ADR-110).
 */
export class OutdatedError extends Error {}

/**
 * One reload of this address. False when it was the last thing done here, or
 * when the tab cannot remember it: a loop of reloads is worse than the crash
 * screen.
 */
function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED) === window.location.href) return false;
    sessionStorage.setItem(RELOADED, window.location.href);
  } catch {
    return false;
  }
  build.load(window.location.href, true);
  return true;
}

/**
 * A route's page as its own chunk, like `lazy`. A chunk that fails to load
 * (most likely deleted by a deploy) marks the build stale and reloads the
 * address once where a full load costs nothing (ADR-110).
 */
// `any`: the bound `lazy` itself puts on a component's props.
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const page = await load();
      try {
        sessionStorage.removeItem(RELOADED);
      } catch {
        // Nothing was remembered either.
      }
      return page;
    } catch (error) {
      build.markStale();
      if (!build.mayLoad(attemptAt(window.location.pathname))) throw new OutdatedError("outdated build");
      if (!reloadOnce()) throw error;
      // The page is going away; settling would only flash the crash screen.
      return new Promise<never>(() => {});
    }
  });
}
