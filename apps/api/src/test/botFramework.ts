/**
 * A stand-in for Microsoft's Bot Framework in the tests (ADR-030): a locally
 * generated RSA key published through the same OpenID metadata and JWKS
 * URLs the verifier reads, and a signer for Bot Connector tokens.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import { BOT_ISSUER, BOT_OPENID_METADATA } from "../modules/notifications/botAuth.js";

const JWKS_URI = "https://login.botframework.com/v1/.well-known/keys";

export interface FakeBotFramework {
  /** Answers the metadata and JWKS URLs; null for any other URL. */
  answer(url: string): Response | null;
  /** How many times the JWKS was fetched. */
  jwksFetches: () => number;
  /** A Bot Connector token; `claims` and `options` override the valid defaults. */
  sign(
    claims?: Record<string, unknown>,
    options?: { kid?: string; expiresIn?: string | number; issuedAt?: number; key?: "main" | "rogue" },
  ): Promise<string>;
}

export async function fakeBotFramework(opts: {
  appId: string;
  serviceUrl: string;
  /** The `endorsements` of the published key; omitted when undefined. */
  endorsements?: string[];
}): Promise<FakeBotFramework> {
  const main = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK & { endorsements?: string[] } = {
    ...(await exportJWK(main.publicKey)),
    kid: "key-1",
    use: "sig",
    ...(opts.endorsements ? { endorsements: opts.endorsements } : {}),
  };
  let fetches = 0;
  return {
    answer(url) {
      if (url === BOT_OPENID_METADATA) {
        return Response.json({ issuer: BOT_ISSUER, jwks_uri: JWKS_URI, id_token_signing_alg_values_supported: ["RS256"] });
      }
      if (url === JWKS_URI) {
        fetches += 1;
        return Response.json({ keys: [jwk] });
      }
      return null;
    },
    jwksFetches: () => fetches,
    async sign(claims = {}, options = {}) {
      const jwt = new SignJWT({ serviceurl: opts.serviceUrl, iss: BOT_ISSUER, aud: opts.appId, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "key-1", typ: "JWT" })
        .setIssuedAt(options.issuedAt)
        .setExpirationTime(options.expiresIn ?? "5m");
      return jwt.sign(options.key === "rogue" ? rogue.privateKey : main.privateKey);
    },
  };
}
