/**
 * A stand-in for Microsoft Entra in the tests (ADR-030): a locally generated
 * RSA key published at the real JWKS URL the SSO verifier reads, and a
 * signer for the Teams SSO tokens of the HEIG Quiz tab — valid by default,
 * each claim overridable to test one refusal at a time.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { ENTRA_JWKS, ENTRA_LOGIN, TEAMS_CLIENT_APP_IDS } from "../modules/notifications/ssoAuth.js";

export const ENTRA_TENANT = "a372f724-c0b2-4ea0-abfb-0eb8c6f84e40";

export interface FakeEntra {
  /** Answers the JWKS URL; null for any other URL. */
  answer(url: string): Response | null;
  /** How many times the JWKS was fetched. */
  jwksFetches: () => number;
  /**
   * A Teams SSO token; `claims` override the valid defaults (a claim set to
   * `undefined` is left out), `options` the signature and the times.
   */
  sign(
    claims?: Record<string, unknown>,
    options?: { kid?: string; expiresIn?: string | number; issuedAt?: number; key?: "main" | "rogue" },
  ): Promise<string>;
}

export async function fakeEntra(opts: { appId: string }): Promise<FakeEntra> {
  const main = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(main.publicKey)), kid: "key-1", use: "sig" };
  let fetches = 0;
  return {
    answer(url) {
      if (url !== ENTRA_JWKS) return null;
      fetches += 1;
      return Response.json({ keys: [jwk] });
    },
    jwksFetches: () => fetches,
    async sign(claims = {}, options = {}) {
      const tid = typeof claims.tid === "string" ? claims.tid : ENTRA_TENANT;
      const all: Record<string, unknown> = {
        iss: `${ENTRA_LOGIN}/${tid}/v2.0`,
        aud: opts.appId,
        tid: ENTRA_TENANT,
        oid: "0f1e2d3c-0000-4000-8000-00000000a1d1",
        name: "Léa Rochat",
        preferred_username: "lea.rochat@heig-vd.ch",
        scp: "access_as_user",
        azp: TEAMS_CLIENT_APP_IDS[0],
        ver: "2.0",
        ...claims,
      };
      const payload = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "key-1", typ: "JWT" })
        .setIssuedAt(options.issuedAt)
        .setExpirationTime(options.expiresIn ?? "1h");
      return jwt.sign(options.key === "rogue" ? rogue.privateKey : main.privateKey);
    },
  };
}
