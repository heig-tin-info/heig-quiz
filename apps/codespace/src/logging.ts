/**
 * The portal's request log. Fastify's default `req` serializer writes the raw
 * URL, and `/launch?token=<JWT>` carries a live single-use credential in its
 * query string: a log reader could replay it before the student does. This
 * serializer masks every `token` parameter (the model is `apps/api`'s
 * `redact.ts`, `redactUrl`; a local copy, since the portal imports no app)
 * and writes no header at all, so neither `Authorization: Bearer <service
 * token>` nor a session or exam cookie reaches the log.
 */
import type { FastifyRequest } from "fastify";

import type { AppConfig } from "./auth/config.js";

/** Query parameters whose value is a credential. */
const SECRET_PARAMS = ["token"];

/** `url` (a request's path and query) with every secret parameter replaced by `…`. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let masked = false;
  for (const name of SECRET_PARAMS) {
    if (params.has(name)) {
      params.set(name, "…");
      masked = true;
    }
  }
  return masked ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** The `req` serializer: what a log line says of a request. */
export function requestLog(req: Pick<FastifyRequest, "method" | "url" | "host" | "ip">) {
  return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip };
}

/** Where log lines go; a test passes one to read them back. */
export interface LogStream {
  write(line: string): void;
}

/** The logger options of every Fastify instance of the portal. */
export function portalLogger(level: AppConfig["LOG_LEVEL"], stream?: LogStream) {
  return { level, serializers: { req: requestLog }, ...(stream ? { stream } : {}) };
}
