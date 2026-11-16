/**
 * Quiz's server-to-server call to the portal (ADR-047, ADR-078 §10): the
 * `codespace` module's one door to it, shared by `service.ts` and
 * `collect.ts`.
 */
import { randomUUID } from "node:crypto";

import { QUIZ_CODESPACE_ISSUER, SERVICE_AUDIENCE, SERVICE_TOKEN_TTL_SECONDS, type ServiceTokenClaims } from "@quiz/contracts";
import { requestBinding, signHs256 } from "@quiz/domain";

import type { AppConfig } from "../../config.js";

/** A portal call never holds a request or a job for long. */
export const PORTAL_TIMEOUT_MS = 10_000;

/**
 * A server-to-server call to the portal. Its bearer is a two-minute
 * service token bound to THIS request — method, path and query, the SHA-256
 * of the exact body sent — with a fresh `jti` the portal consumes once
 * (audit L25, ADR-078 amendment of 2026-10-11): a token seen in transit is
 * worth neither a second call nor another route or body.
 */
export async function portalCall(
  config: AppConfig,
  now: Date,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
  timeoutMs = PORTAL_TIMEOUT_MS,
): Promise<Response> {
  const url = new URL(`${config.CODESPACE_URL}${path}`);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const iat = Math.floor(now.getTime() / 1000);
  const claims: ServiceTokenClaims = {
    iss: QUIZ_CODESPACE_ISSUER,
    aud: SERVICE_AUDIENCE,
    iat,
    exp: iat + SERVICE_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
    ...(await requestBinding(method, url.pathname + url.search, body)),
    method,
  };
  const token = await signHs256({ ...claims }, config.CODESPACE_LAUNCH_SECRET);
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
