/**
 * The little of the Teams JavaScript client the HEIG Quiz tab uses
 * (ADR-030), behind one interface: am I inside Teams, where does the deep
 * link that opened me point, who is the user (the SSO token), and open a URL
 * in the system browser.
 *
 * `@microsoft/teams-js` is loaded on demand, from the tab only: the rest of
 * the app never carries it. Under `pnpm dev:mock` a fake host stands in for
 * Teams (`mock/teams.ts`), so the tab's states can be looked at in a plain
 * browser; production builds drop that branch.
 */

export interface TeamsHost {
  /** The tab's `subEntityId` from the deep link that opened it, if any. */
  subPageId: string | undefined;
  /** The Teams SSO token of the user, for our API (`access_as_user`). */
  getAuthToken(): Promise<string>;
  /** Opens a URL outside Teams, in the user's browser. */
  openLink(url: string): Promise<void>;
}

/** How long Teams has to answer the handshake before the page decides it is not inside Teams. */
const HANDSHAKE_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * The Teams host, or null when the page is not running inside Teams (opened
 * in a browser tab, or framed by something else: the handshake then fails
 * at once, or never answers).
 */
export async function connectTeams(): Promise<TeamsHost | null> {
  if (import.meta.env.VITE_MOCK === "1") {
    const { fakeTeamsHost } = await import("../mock/teams");
    return fakeTeamsHost();
  }
  const { app, authentication } = await import("@microsoft/teams-js");
  try {
    await withTimeout(app.initialize(), HANDSHAKE_MS);
    const context = await withTimeout(app.getContext(), HANDSHAKE_MS);
    return {
      subPageId: context.page.subPageId || undefined,
      getAuthToken: () => authentication.getAuthToken(),
      openLink: (url) => app.openLink(url),
    };
  } catch {
    return null;
  }
}
