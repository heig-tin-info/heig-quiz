/**
 * The passive status of the third-party services (ADR-055 §6): what THIS
 * process saw of its own calls to the mailer, the identity provider, Teams,
 * the LLM provider and the GitHub App — the last success, the last failure
 * and its class — kept in memory, fed at the one call site of each
 * transport through {@link tracked}, the one way in. The `service.*`
 * checks of the registry read it; `serviceStatus` of `@quiz/domain` judges it.
 *
 * In memory and per process on purpose: nothing new to migrate, nothing
 * written on a hot path, and the question it answers — "is the provider
 * answering us now?" — is about the process that calls it. A restart
 * forgets it (the check is `unknown` until the next call), and in
 * `WORKER_MODE=web` a service only the worker calls (the mail, Teams, the
 * LLM of the grading pass) is `unknown` in the web process.
 *
 * Never an address, a body, a message: a failure is kept as its CLASS
 * (`http_502`, `timeout`, `invalid_grant`), from a closed vocabulary.
 */
import type { FastifyInstance } from "fastify";

import type { ServiceName, ServiceRecord } from "@quiz/domain";

import { perApp } from "./perApp.js";

const records = new Map<ServiceName, ServiceRecord & { lastError: string | null }>();

/** A service's record, or the never-used one. */
export function serviceRecord(name: ServiceName): ServiceRecord & { lastError: string | null } {
  return (
    records.get(name) ?? { lastOkAt: null, lastErrorAt: null, lastError: null, failingSince: null, failuresSinceOk: 0 }
  );
}

/** One call's outcome: `ok`, or the error it failed with. Wall clock, like the ticker's lag. */
function recordService(name: ServiceName, outcome: { ok: true } | { ok: false; error: unknown }): void {
  const now = new Date();
  const r = serviceRecord(name);
  records.set(
    name,
    outcome.ok
      ? { ...r, lastOkAt: now, failingSince: null, failuresSinceOk: 0 }
      : {
          ...r,
          lastErrorAt: now,
          lastError: errorClass(outcome.error),
          failingSince: r.failingSince ?? now,
          failuresSinceOk: r.failuresSinceOk + 1,
        },
  );
}

/**
 * Runs one call to a service and records its outcome; the result or the
 * error passes through untouched. `counts(err) === false` records an error
 * the service is not to blame for (a refusal about one recipient) as an
 * answer, hence a success.
 */
export async function tracked<T>(
  name: ServiceName,
  run: () => Promise<T>,
  counts: (err: unknown) => boolean = () => true,
): Promise<T> {
  try {
    const value = await run();
    recordService(name, { ok: true });
    return value;
  } catch (error) {
    recordService(name, counts(error) ? { ok: false, error } : { ok: true });
    throw error;
  }
}

/** For the tests: every service back to "never used". */
export function resetServiceRecords(): void {
  records.clear();
}

/**
 * The OAuth 2.0 / OIDC error codes (RFC 6749 §4.1.2.1 and §5.2, OIDC Core
 * §3.1.2.6). openid-client 6 (oauth4webapi `ResponseBodyError`,
 * `AuthorizationResponseError`) sets `.error` to the `error` parameter of
 * the token response or of the callback's query string — the latter comes
 * from the browser, so only a registered code is kept, anything else is
 * `oauth_error`.
 */
const OAUTH_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
  "account_selection_required",
]);

/**
 * The class of a failure, never its words (a provider's message may echo an
 * address): a timeout, an OAuth error code, an HTTP status, a network code,
 * or `error`.
 */
export function errorClass(err: unknown, depth = 0): string {
  if (typeof err !== "object" || err === null) return "error";
  const e = err as { name?: unknown; error?: unknown; status?: unknown; cause?: unknown };
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  // An OAuth error (`invalid_grant`): openid-client's `.error` (see OAUTH_CODES).
  if (typeof e.error === "string") return OAUTH_CODES.has(e.error) ? e.error : "oauth_error";
  if (typeof e.status === "number" && Number.isInteger(e.status)) return `http_${e.status}`;
  // `fetch failed`: the socket's code (`ECONNREFUSED`, `ENOTFOUND`) is on its cause.
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && /^E[A-Z]{2,20}$/.test(code)) return `network_${code.toLowerCase()}`;
  if (e.cause !== undefined && depth < 3) {
    const inner = errorClass(e.cause, depth + 1);
    if (inner !== "error") return inner;
  }
  return "error";
}

/**
 * When each application's ticker last COMPLETED a pass (wall clock, ms), for
 * the system status (N-OPS-03): a pass that hangs, or a loop that stopped,
 * shows as a growing lag. No entry: this process runs no ticker
 * (`WORKER_MODE=web`). Kept here, a leaf, rather than in `ticker.ts`, so the
 * status reads it without loading the tasks it observes.
 */
const lastPass = perApp<number>();

/** Records the end of a pass of this app's ticker (`startTicker` only). */
export function markTickerPass(app: FastifyInstance, at: number): void {
  lastPass.set(app, at);
}

/** The end of the last completed pass of this app's ticker; `undefined` without one. */
export function lastTickOf(app: FastifyInstance): number | undefined {
  return lastPass.get(app);
}
