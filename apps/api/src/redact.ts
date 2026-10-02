/**
 * The URLs that carry a secret, masked before the request log writes them
 * down. ONE table: a new secret-bearing page is a line here, not a second
 * serializer.
 *
 *  - `/app/auth/seb/<secret>`: the one-time ticket of a Safe Exam Browser
 *    launch (ADR-027), in the path;
 *  - `/app/auth/as/<secret>`: the one-time link of an impersonation
 *    (ADR-034), in the path;
 *  - `/teams/link?token=…`: the single-use token of a pending Teams link
 *    (ADR-030), in the query — the SPA page as the server serves it;
 *  - `/app/auth/github/callback?code=…`: the one-time code GitHub hands back
 *    at the end of an account link (M2-03), in the query;
 *  - `/pair?code=…` and `/app/api/pair/<code>`: a kiosk station's user code
 *    (ADR-051 §8), in the query of the phone's page and in the path of the
 *    route that reads it;
 *  - and any of them as the `next=` (or `returnTo=`) of a login round
 *    trip, or the `return=` of a GitHub account link, which carries the page
 *    to come back to, token included.
 *
 * And the GitHub tokens (N-SEC-16) and the Anthropic API keys (ADR-058 §3),
 * wherever they appear in a text:
 * `redactTokens` is the one pattern table, used by the git wrapper
 * (`github/git.ts`) on every failure message and by the request log.
 */
import type { FastifyRequest } from "fastify";

// The paths alone, from a file that imports nothing: every module logs.
import { GITHUB_CALLBACK_PATH, IMPERSONATION_PATH, LAUNCH_PATH } from "./auth/paths.js";

/** Everything after one of these prefixes is a secret. */
const SECRET_PREFIXES: readonly string[] = [
  LAUNCH_PATH,
  IMPERSONATION_PATH,
  GITHUB_CALLBACK_PATH,
  "/teams/link",
  "/app/api/pair/",
];
/** The phone's page with any query, however its path is spelled (`/pair?`, `/pair/?`, `/pair//?`). */
const PAIR_PAGE = /^\/pair\/*\?/;

/** The query parameters that hold another URL of the app. */
const RETURN_PARAMS: readonly string[] = ["next", "returnTo", "return"];

/** The part of `url` kept before the mask, or undefined when it carries no secret. */
const secret = (url: string) =>
  SECRET_PREFIXES.find((prefix) => url.startsWith(prefix)) ?? PAIR_PAGE.exec(url)?.[0];

/**
 * `text` with every GitHub token masked: the installation token of an
 * `https://x-access-token:<token>@github.com/…` remote that git echoes on a
 * failure, and any bare token by its prefix (`ghs_` installation, `ghu_`
 * user-to-server, `ghp_` personal, `gho_` OAuth, `ghr_` refresh), and the
 * `AUTHORIZATION: basic <base64>` header the git wrapper hands to git
 * (`github/git.ts`). Tokens expire within the hour, but they are never
 * stored nor logged at all. A safety net: the wrapper puts no token in a URL.
 */
export function redactTokens(text: string): string {
  return text
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)[A-Za-z0-9+/=._-]+/gi, "$1***")
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
    .replace(/\bgh[a-z]_[A-Za-z0-9_]+/g, "gh*_***")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}

/** `url` (a request's path and query) with every secret replaced by `…`. */
export function redactUrl(url: string): string {
  return redactTokens(redactSecretPages(url));
}

function redactSecretPages(url: string): string {
  const prefix = secret(url);
  if (prefix) return `${prefix}…`;
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let masked = false;
  for (const name of RETURN_PARAMS) {
    const value = params.get(name);
    if (value !== null && secret(value)) {
      params.set(name, "…");
      masked = true;
    }
  }
  return masked ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** The `req` serializer of the request log: what a line says of a request. */
export function requestLog(req: Pick<FastifyRequest, "method" | "url" | "host" | "ip">) {
  return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip };
}
