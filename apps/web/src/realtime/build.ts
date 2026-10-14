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
  private writes = 0;

  constructor(private readonly client: string | null) {}

  isStale = () => this.stale;

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

  /** A write in flight, until the returned callback: a full load would lose its answer. */
  write = () => {
    this.writes++;
    return () => {
      this.writes--;
    };
  };

  /** Stale, and nothing a full load would cost: no attempt on screen, no confinement, no write. */
  mayLoad = (attemptOnScreen: boolean) =>
    this.stale && !attemptOnScreen && !this.confined && this.writes === 0;

  /** The full load itself: `path` from the server, with whatever build it now serves. */
  load = (path: string, replace = false) => {
    if (replace) window.location.replace(path);
    else window.location.assign(path);
  };

  /**
   * Vite's signal that a chunk or one of its preloads failed: a deleted file
   * of an older build, most likely. Prevented, so the failure reaches the
   * page loader (`lazyPage`) rather than an unhandled rejection.
   */
  start = () => {
    const onPreloadError = (event: Event) => {
      event.preventDefault();
      this.markStale();
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  };
}

export const build = new BuildMonitor(__COMMIT__?.sha ?? null);
