import { createSignal } from "./ui/state";

/**
 * Whether this tab runs an older build than the API (ADR-110), and whether a
 * move to the next screen may load the new one. Stale is learnt from the
 * build header of a signed-in API answer, or from a chunk that failed to
 * load. Nothing here reloads a mounted screen: the router and the page
 * loader ask `mayLoad` at the moments a full load replaces nothing.
 */
export class BuildMonitor {
  private stale = false;
  private confined = false;
  private holds = 0;
  private signal = createSignal();

  constructor(private readonly client: string | null) {}

  isStale = () => this.stale;
  isConfined = () => this.confined;
  /** Told when the last hold is released. */
  subscribe = this.signal.subscribe;

  /** The API's build header; null on an answer without one (signed out, development). */
  observe = (server: string | null) => {
    // A build that knows no commit (a mock, a bare checkout) never goes stale.
    if (server && this.client && server !== this.client) this.stale = true;
  };

  markStale = () => {
    this.stale = true;
  };

  /** A `seb` or `kiosk` session keeps its client to the end (ADR-027, ADR-051). */
  confine = (confined: boolean) => {
    this.confined = confined;
  };

  /**
   * Something a full load would lose — a write on the wire, a screen behind
   * its leave guard — until the returned release (called once).
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
        stop();
        resolve();
      });
    });

  /** Stale, and nothing a full load would cost: not answering, not confined, nothing held. */
  mayLoad = (answering: boolean) => this.stale && !answering && !this.confined && this.holds === 0;

  /** The full load itself: `path` from the server, with whatever build it now serves. */
  load = (path: string, replace = false) => {
    if (replace) window.location.replace(path);
    else window.location.assign(path);
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
