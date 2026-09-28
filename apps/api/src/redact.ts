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
 *  - and either of them as the `next=` (or `returnTo=`) of a login round
 *    trip, which carries the page to come back to, token included.
 */
import type { FastifyRequest } from "fastify";

import { IMPERSONATION_PATH } from "./auth/impersonation.js";
import { LAUNCH_PATH } from "./auth/seb.js";

/** Everything after one of these prefixes is a secret. */
const SECRET_PREFIXES: readonly string[] = [LAUNCH_PATH, IMPERSONATION_PATH, "/teams/link"];

/** The query parameters that hold another URL of the app. */
const RETURN_PARAMS: readonly string[] = ["next", "returnTo"];

const secret = (url: string) => SECRET_PREFIXES.find((prefix) => url.startsWith(prefix));

/** `url` (a request's path and query) with every secret replaced by `…`. */
export function redactUrl(url: string): string {
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
