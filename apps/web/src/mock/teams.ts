/**
 * A stand-in for Microsoft Teams around the HEIG Quiz tab (ADR-030), for
 * `pnpm dev:mock` only: `notifications/teamsHost.ts` loads it instead of
 * `@microsoft/teams-js`. The scene comes from `?teams=` (not remembered):
 *
 *  - absent — the page is not inside Teams;
 *  - `unlinked` — inside Teams, the account not linked yet;
 *  - `linked` — linked, opened from the app bar;
 *  - `target` — linked, opened from a notification (a released result);
 *  - `refused` — a Teams account of an organization not allowed;
 *  - `sso` — Teams refuses the SSO token (the user never consented).
 *
 * The tab's endpoint itself is served by section 2 (`pool.ts`), which reads
 * the same scene.
 */
import type { TeamsHost } from "../notifications/teamsHost";
import { teamsScene } from "./runtime";

/** The released attempt of the student persona (grading.ts). */
const RELEASED_ATTEMPT = "22222222-2222-4222-8222-222222222223";

export function fakeTeamsHost(): TeamsHost | null {
  if (teamsScene === null) return null;
  return {
    subPageId: teamsScene === "target" ? `/attempts/${RELEASED_ATTEMPT}/feedback` : undefined,
    getAuthToken: async () => {
      if (teamsScene === "sso") throw new Error("resourceRequiresConsent");
      return "header.payload.signature";
    },
    openLink: async (url) => {
      window.open(url, "_blank", "noopener");
    },
  };
}
