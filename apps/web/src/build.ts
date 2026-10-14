import { useEffect, useState } from "react";

import { connection as liveConnection, type ConnectionMonitor } from "./realtime/connection";
import { createSignal } from "./ui/state";

/** The build this tab reloaded itself toward, so one that comes back stale does not loop. */
const RELOADED_TO = "quiz:build-reload-to";
/** The scroll of an address reloaded in place, for the new build to put back. */
const SCROLL = "quiz:build-scroll";
/** How long after the update overlay closed a reload still reads as part of the update. */
const AFTER_UPDATE_MS = 30_000;
/** How long the restored scroll waits for the page to grow tall enough. */
const RESTORE_MS = 5_000;

type Connection = Pick<ConnectionMonitor, "getSnapshot" | "subscribe">;

/** Inputs that take no typing: a click on them leaves nothing half-written. */
const UNTYPED_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "file", "range", "color"]);

/** Whether `element` is a field the reader may be typing in. */
function editing(element: Element | null): boolean {
  if (element instanceof HTMLInputElement) return !UNTYPED_INPUTS.has(element.type);
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

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
    if (this.confined === confined) return;
    this.confined = confined;
    this.signal.emit();
  };

  /** Whether anything holds the tab on its build now. */
  isHeld = () => this.holds > 0;

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
   * than `AFTER_UPDATE_MS` ago — and, either way, no field that takes typing
   * has the focus (a tab switch leaves it there, and a field saved on blur
   * holds nothing until it is blurred). Asked again whenever the tab turns
   * stale, a hold or the confinement changes, the connection changes, the tab
   * is hidden or a field loses the focus; never while the API is away. Once
   * per server build: a tab that comes back stale stays on the next-screen
   * rule. Returns the stop.
   */
  watch = (answering: () => boolean, connection: Connection = liveConnection) => {
    let previous = connection.getSnapshot();
    let closedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const consider = () => {
      const unnoticed = document.visibilityState === "hidden" || Date.now() - closedAt < AFTER_UPDATE_MS;
      if (!unnoticed || editing(document.activeElement) || connection.getSnapshot() !== "connected") return;
      if (!this.mayLoad(answering()) || !once(RELOADED_TO, this.server ?? "unknown")) return;
      this.load(window.location.href, true);
    };
    // After the event's own handlers: a write a blur starts takes its hold
    // synchronously in `api`, within the microtasks this timer waits out.
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(consider, 0);
    };
    const onConnection = () => {
      const state = connection.getSnapshot();
      if (previous === "updating" && state === "connected") closedAt = Date.now();
      previous = state;
      consider();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") later();
    };
    const stops = [this.subscribe(consider), connection.subscribe(onConnection)];
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusout", later);
    onVisibility();
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", later);
    };
  };

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

/** Holds while any of `values` differs from what it was on mount (by identity): a form edited, not yet saved. */
export function useHoldChanged(values: Readonly<Record<string, unknown>>): void {
  const [initial] = useState(values);
  useHold(Object.keys(values).some((key) => values[key] !== initial[key]));
}

/**
 * True the first time this tab sets `key` to `value`, false after — and when
 * the tab cannot remember it: a loop of reloads is worse than none.
 */
export function once(key: string, value: string): boolean {
  try {
    if (sessionStorage.getItem(key) === value) return false;
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
