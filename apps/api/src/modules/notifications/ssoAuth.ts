/**
 * The Teams SSO token of the HEIG Quiz tab (ADR-030): who is looking at the
 * tab, as Microsoft Entra says. The tab asks Teams for it
 * (`authentication.getAuthToken()`) and sends it to
 * `POST /app/api/notifications/teams/tab` as `Authorization: Bearer`; nothing
 * else authenticates that call — there is no Quiz session inside Teams.
 *
 * It is an Entra v2 ACCESS token issued to the Teams client for OUR API
 * (the Entra application sets `api.requestedAccessTokenVersion: 2`, so the
 * audience is the bare client id and the issuer the v2 one). The checks, all
 * of them required:
 *
 *  1. a `Bearer` JWT, RS256 only, signed by a key of Entra's common JWKS
 *     (`login.microsoftonline.com/common/discovery/v2.0/keys`; jose's remote
 *     key set keeps them a day and re-reads them at most every five minutes
 *     when a token names an unknown key — which also bounds what a flood of
 *     forged tokens costs);
 *  2. `iss` EXACTLY `https://login.microsoftonline.com/<tid>/v2.0`, the tid
 *     being the token's own: the common key set signs for every tenant, so
 *     the issuer is pinned to the tenant the token claims, never "any";
 *  3. `aud` = `TEAMS_CLIENT_ID`: issued for our API and nothing else;
 *  4. `tid` among `TEAMS_ALLOWED_TENANTS` (empty admits every tenant) — a
 *     403, so the tab can say why;
 *  5. a delegated token: `scp` holds `access_as_user`, and `idtyp` is not
 *     `app` (an application token of the same audience proves no person);
 *  6. `azp` is a Teams client — desktop and mobile, or web: the token was
 *     obtained by Teams on the user's behalf, not by any application a user
 *     consented to;
 *  7. within `exp`/`nbf`, with five minutes of clock skew;
 *  8. `oid` present: the identity the link is keyed on, with `tid`.
 *
 * The token is never logged (`authorization` is redacted by the logger);
 * the reason of a refusal is, and it never quotes the token.
 *
 * `fetch` is injected: the tests serve a locally generated key through it.
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

import { tenantAllowed, type AllowedTenants, type TeamsIdentity } from "./teamsLink.js";

export const ENTRA_LOGIN = "https://login.microsoftonline.com";
export const ENTRA_JWKS = `${ENTRA_LOGIN}/common/discovery/v2.0/keys`;
/** The scope the Entra application exposes for Teams SSO. */
export const SSO_SCOPE = "access_as_user";
/**
 * The Teams clients Microsoft documents for tab SSO, which the Entra
 * application pre-authorizes: desktop and mobile, then web.
 */
export const TEAMS_CLIENT_APP_IDS: readonly string[] = [
  "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
  "5e3ce6c0-2b1f-4285-8d4b-75ee78787346",
];
const CLOCK_TOLERANCE_S = 5 * 60;
const TIMEOUT_MS = 10_000;

export class SsoAuthError extends Error {
  constructor(
    message: string,
    /** 401: not a token for us; 403: a genuine one, of a tenant not allowed. */
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "SsoAuthError";
  }
}

export interface SsoTokenVerifier {
  /** Throws a {@link SsoAuthError}; never logs the token. */
  verify(authorization: string | undefined): Promise<TeamsIdentity>;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function createSsoTokenVerifier(opts: {
  appId: string;
  tenants: AllowedTenants;
  fetchImpl?: typeof fetch;
}): SsoTokenVerifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const keys = createRemoteJWKSet(new URL(ENTRA_JWKS), {
    cacheMaxAge: 24 * 60 * 60 * 1000,
    cooldownDuration: 5 * 60 * 1000,
    timeoutDuration: TIMEOUT_MS,
    [customFetch]: (url, init) => fetchImpl(url, init),
  });

  return {
    async verify(authorization) {
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
      if (!match) throw new SsoAuthError("no bearer token");
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(match[1]!, keys, {
          audience: opts.appId,
          algorithms: ["RS256"],
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ["exp", "iss", "tid", "oid"],
        }));
      } catch (err) {
        // jose's message names the failed check, never the token itself.
        throw new SsoAuthError(err instanceof Error ? err.message : "invalid token");
      }
      const tid = text(payload.tid);
      if (!/^[0-9a-f-]{36}$/i.test(tid)) throw new SsoAuthError("tid is not a tenant id");
      if (payload.iss !== `${ENTRA_LOGIN}/${tid}/v2.0`) throw new SsoAuthError("unexpected iss");
      if (payload.idtyp === "app") throw new SsoAuthError("an application token");
      const scopes = text(payload.scp).split(" ");
      if (!scopes.includes(SSO_SCOPE)) throw new SsoAuthError("scope access_as_user missing");
      if (!TEAMS_CLIENT_APP_IDS.includes(text(payload.azp))) throw new SsoAuthError("azp is not a Teams client");
      const aadObjectId = text(payload.oid);
      if (aadObjectId === "") throw new SsoAuthError("no oid");
      const tenantId = tid.toLowerCase();
      if (!tenantAllowed(opts.tenants, tenantId)) throw new SsoAuthError("tenant not allowed", 403);
      const teamsUsername = text(payload.preferred_username);
      return {
        tenantId,
        aadObjectId,
        teamsName: text(payload.name) || teamsUsername || aadObjectId,
        teamsUsername,
      };
    },
  };
}
