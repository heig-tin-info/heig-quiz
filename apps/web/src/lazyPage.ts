import { lazy, type ComponentType } from "react";

import { build } from "./build";
import { answeringAt } from "./router";

/** The address this tab reloaded once for a page's missing chunk. */
const RELOADED = "quiz:build-reload";

/**
 * A page whose chunk is gone where the tab may not reload by itself (a page
 * where the student answers, a confined session): `CrashBoundary` offers the
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
 * A route's page as its own chunk, like `lazy`. A chunk whose import
 * rejects (most likely deleted by a deploy) marks the build stale and
 * reloads the address once where a full load costs nothing (ADR-110): never
 * on a page where the student answers nor in a confined session, and only
 * once nothing is held (a write on the wire) — the suspense fallback stays
 * up meanwhile.
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
      // The page being opened, not the one left: the way into an answering
      // page whose chunk is gone ends on the outdated screen.
      if (answeringAt(window.location.pathname) || build.isConfined()) throw new OutdatedError("outdated build");
      await build.settled();
      if (!reloadOnce()) throw error;
      // The page is going away; settling would only flash the crash screen.
      return new Promise<never>(() => {});
    }
  });
}
