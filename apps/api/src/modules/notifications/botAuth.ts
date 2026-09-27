/**
 * The authentication of Bot Connector's calls to the messaging endpoint
 * (ADR-030), as Microsoft specifies it for a bot that does not use the SDK
 * ("Authenticate requests from the Bot Connector service to your bot",
 * learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication):
 *
 *  1. a `Bearer` JWT in `Authorization`;
 *  2. signed RS256 by a key of the JWKS that the Bot Framework OpenID
 *     metadata names (`login.botframework.com`). jose's remote key set holds
 *     them a day and re-reads them, at most every five minutes, when a token
 *     names a key it does not have — which also bounds what a flood of forged
 *     tokens can cost;
 *  3. issuer `https://api.botframework.com` — the ONLY one. A single-tenant
 *     bot changes the tenant of the tokens the bot REQUESTS, not of those
 *     Bot Connector sends; the Entra issuers of the same page belong to the
 *     Emulator path, which a production bot must not accept;
 *  4. audience = the bot's application id (`TEAMS_CLIENT_ID`);
 *  5. within `exp`/`nbf`, with Microsoft's five minutes of clock skew;
 *  6. when the signing key carries `endorsements`, `msteams` among them —
 *     the one channel this bot serves (a 403, as the page prescribes);
 *  7. its `serviceUrl` claim equal to the activity's — checked by the route,
 *     which alone has the body (`claims.serviceUrl`).
 *
 * `fetch` is injected: the tests serve a locally generated key through it.
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

export const BOT_OPENID_METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_ISSUER = "https://api.botframework.com";
const CLOCK_TOLERANCE_S = 5 * 60;
const TIMEOUT_MS = 10_000;

export class BotAuthError extends Error {
  constructor(
    message: string,
    /** 401: not Microsoft's; 403: Microsoft's, but not for the Teams channel. */
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "BotAuthError";
  }
}

export interface BotClaims {
  /** The `serviceUrl` the token vouches for, to compare with the activity's. */
  serviceUrl: string;
}

export interface BotTokenVerifier {
  /** Throws a {@link BotAuthError}; never logs the token. */
  verify(authorization: string | undefined): Promise<BotClaims>;
}

export function createBotTokenVerifier(opts: { appId: string; fetchImpl?: typeof fetch }): BotTokenVerifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  type KeySet = ReturnType<typeof createRemoteJWKSet>;

  /**
   * The key set, once the metadata named its URL. Resolved on the first call
   * and kept; a failure is forgotten, so the next call asks again.
   */
  let keySet: Promise<KeySet> | null = null;
  function keys(): Promise<KeySet> {
    keySet ??= (async () => {
      const res = await fetchImpl(BOT_OPENID_METADATA, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Bot Framework metadata: ${res.status}`);
      const { jwks_uri: uri } = (await res.json()) as { jwks_uri?: unknown };
      if (typeof uri !== "string" || !uri.startsWith("https://")) {
        throw new Error("Bot Framework metadata without an https jwks_uri");
      }
      return createRemoteJWKSet(new URL(uri), {
        cacheMaxAge: 24 * 60 * 60 * 1000,
        cooldownDuration: 5 * 60 * 1000,
        timeoutDuration: TIMEOUT_MS,
        [customFetch]: (url, init) => fetchImpl(url, init),
      });
    })().catch((err: unknown) => {
      keySet = null;
      throw err;
    });
    return keySet;
  }

  return {
    async verify(authorization) {
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
      if (!match) throw new BotAuthError("no bearer token");
      let payload: JWTPayload;
      try {
        const set = await keys();
        ({ payload } = await jwtVerify(
          match[1]!,
          async (header, token) => {
            const key = await set(header, token);
            // The key jose selected, as Microsoft published it: its endorsements.
            const jwk = set.jwks()?.keys.find((k) => k.kid === header.kid) as { endorsements?: unknown } | undefined;
            if (Array.isArray(jwk?.endorsements) && !jwk.endorsements.includes("msteams")) {
              throw new BotAuthError("key not endorsed for msteams", 403);
            }
            return key;
          },
          {
            issuer: BOT_ISSUER,
            audience: opts.appId,
            algorithms: ["RS256"],
            clockTolerance: CLOCK_TOLERANCE_S,
            requiredClaims: ["exp"],
          },
        ));
      } catch (err) {
        if (err instanceof BotAuthError) throw err;
        // jose's message names the failed check, never the token itself.
        throw new BotAuthError(err instanceof Error ? err.message : "invalid token");
      }
      // The documentation writes `serviceUrl`; the tokens (and the SDK,
      // `AuthenticationConstants.ServiceUrlClaim`) spell it `serviceurl`.
      const serviceUrl = payload.serviceurl ?? payload.serviceUrl;
      if (typeof serviceUrl !== "string") throw new BotAuthError("no serviceUrl claim");
      return { serviceUrl };
    },
  };
}
