import { useEffect } from "react";

import { connection as liveConnection, type ConnectionMonitor } from "./realtime/connection";
import { createSignal } from "./ui/state";

/** The build this tab reloaded itself toward, so one that comes back stale does not loop. */
const RELOADED_TO = "quiz:build-reload-to";
/** The scroll of an address reloaded in place, for the new build to put back. */
const SCROLL = "quiz:build-scroll";
/** How long after the update overlay closed a reload still reads as part of the update. */
const AFTER_UPDATE_MS = 30_000;
/** A hidden tab's blur may start a write (a field saved on blur): it gets this long to go on the wire. */
const HIDDEN_DELAY_MS = 1_000;
/** How long the restored scroll waits for the page to grow tall enough. */
const RESTORE_MS = 5_000;

type Connection = Pick<ConnectionMonitor, "getSnapshot" | "subscribe">;

/**
 * Whether this tab runs an older build than the API (ADR-110), and whether it
 * may load the new one. Stale is learnt from the build header of a signed-in
 * API answer, or from a chunk that failed to load. The router and the page
 * loader ask `mayLoad` at the moments a full load replaces nothing; `watch`
 * reloads a clean screen by itself at two moments its reader loses nothing:
 * while the tab is hidden, and right after the update overlay closed.
 */
export class BuildMonitor {
  private stale = false;
  private confined = false;
  private holds = 0;
  /** The API's build, once a header named one. */
  private server: string | null = null;
  private signal = createSignal();

  constructor(private readonly client: string | null) {}

  isStale = () => this.stale;
  isConfined = () => this.confined;
  /** Told when the tab turns stale, and when the last hold is released. */
  subscribe = this.signal.subscribe;

  /** The API's build header; null on an answer without one (signed out, development). */
  observe = (server: string | null) => {
    if (server) this.server = server;
    // A build that knows no commit (a mock, a bare checkout) never goes stale.
    if (server && this.client && server !== this.client) this.markStale();
  };

  markStale = () => {
    if (this.stale) return;
    this.stale = true;
    this.signal.emit();
  };

  /** A `seb` or `kiosk` session keeps its client to the end (ADR-027, ADR-051). */
  confine = (confined: boolean) => {
    this.confined = confined;
  };

  /**
   * Something a full load would lose — a write on the wire, unsaved work on
   * screen — until the returned release (called once).
   */
  hold = () => {
    this.holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--this.holds === 0) this.signal.emit();
    };
  };

  /** Resolves once nothing is held. */
  settled = () =>
    new Promise<void>((resolve) => {
      if (this.holds === 0) return resolve();
      const stop = this.subscribe(() => {
        if (this.holds > 0) return;
        stop();
        resolve();
      });
    });

  /** Stale, and nothing a full load would cost: not answering, not confined, nothing held. */
  mayLoad = (answering: boolean) => this.stale && !answering && !this.confined && this.holds === 0;

  /**
   * The full load itself: `path` from the server, with whatever build it now
   * serves. The same address keeps its scroll (`restoreScroll`).
   */
  load = (path: string, replace = false) => {
    if (new URL(path, window.location.href).href === window.location.href) {
      try {
        sessionStorage.setItem(SCROLL, JSON.stringify({ href: window.location.href, y: window.scrollY }));
      } catch {
        // The page comes back at its top.
      }
    }
    if (replace) window.location.replace(path);
    else window.location.assign(path);
  };

  /**
   * After a load: the scroll `load` kept for this address, put back once the
   * page is tall enough (or after `RESTORE_MS`), unless the reader scrolled
   * first. Used once, then forgotten.
   */
  restoreScroll = () => {
    let saved: unknown;
    try {
      const raw = sessionStorage.getItem(SCROLL);
      sessionStorage.removeItem(SCROLL);
      saved = raw === null ? null : JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof saved !== "object" || saved === null) return;
    const { href, y } = saved as { href?: unknown; y?: unknown };
    if (href !== window.location.href || typeof y !== "number" || !(y > 0)) return;
    const deadline = Date.now() + RESTORE_MS;
    const step = () => {
      if (window.scrollY !== 0) return;
      if (document.documentElement.scrollHeight - window.innerHeight >= y || Date.now() >= deadline) {
        window.scrollTo(0, y);
        return;
      }
      setTimeout(step, 100);
    };
    setTimeout(step, 0);
  };

  /**
   * Reloads the address on view by itself when `mayLoad` holds and the reader
   * loses no context: the tab is hidden, or the update overlay closed less
   * than `AFTER_UPDATE_MS` ago. Asked again whenever the tab turns stale, the
   * last hold drops, the connection changes or the tab is hidden; never while
   * the API is away. Once per server build: a tab that comes back stale stays
   * on the next-screen rule. Returns the stop.
   */
  watch = (answering: () => boolean, connection: Connection = liveConnection) => {
    let previous = connection.getSnapshot();
    let closedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const consider = () => {
      const unnoticed = document.visibilityState === "hidden" || Date.now() - closedAt < AFTER_UPDATE_MS;
      if (!unnoticed || connection.getSnapshot() !== "connected") return;
      if (!this.mayLoad(answering()) || !this.claim()) return;
      this.load(window.location.href, true);
    };
    const onConnection = () => {
      const state = connection.getSnapshot();
      if (previous === "updating" && state === "connected") closedAt = Date.now();
      previous = state;
      consider();
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") timer = setTimeout(consider, HIDDEN_DELAY_MS);
    };
    const stops = [this.subscribe(consider), connection.subscribe(onConnection)];
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  };

  /** The one reload toward the server's build; false once done, or when the tab cannot remember it. */
  private claim(): boolean {
    const target = this.server ?? "unknown";
    try {
      if (sessionStorage.getItem(RELOADED_TO) === target) return false;
      sessionStorage.setItem(RELOADED_TO, target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Vite's signal that a chunk or one of its preloads failed: a deleted file
   * of an older build, most likely. Not prevented: the import still rejects,
   * for its caller (`lazyPage`, or any other) to handle.
   */
  start = () => {
    const onPreloadError = () => this.markStale();
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  };
}

export const build = new BuildMonitor(__COMMIT__?.sha ?? null);

/**
 * While `active`, the screen holds unsaved work that a reload would lose: the
 * tab stays on its build (ADR-110). No prompt — `useLeaveGuard` adds one.
 */
export function useHold(active: boolean): void {
  useEffect(() => (active ? build.hold() : undefined), [active]);
}
