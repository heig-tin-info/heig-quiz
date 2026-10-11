/**
 * `/s/<session>/*` → the container's code-server.
 *
 * **Invariant 5 of CLAUDE.md**: this proxy never reads an SEB header. It knows
 * the portal's session cookie and, in exam mode, the `exam_session` cookie that
 * `seb/routes.ts` set once, at verification time. The reason is in analyse.md
 * § 4.5: nothing guarantees that SEB adds its headers to websocket upgrades or
 * to service worker requests.
 *
 * Websocket upgrades go through the Fastify router (`@fastify/http-proxy`
 * redirects them to `fastify.routing`), so the `preHandler` below applies to
 * them too: a session without a cookie cannot open a socket.
 *
 * The upstream is dynamic (one address per container): `replyOptions.getUpstream`
 * is synchronous, so the `preHandler` — which, for its part, may await the
 * database and Podman — deposits the address in a cache that `getUpstream`
 * reads back.
 *
 * **One origin for every session (audit L24).** All sessions are served from
 * the portal's one origin, so nothing a session serves may act on that origin
 * as a whole. code-server runs with `--disable-proxy` (images/c-dev), and this
 * proxy is the second layer: it refuses code-server's port proxy
 * (`/proxy/<port>/`, `/absproxy/<port>/`), drops `Set-Cookie` and
 * `Service-Worker-Allowed` from every answer, and serves
 * `/vscode-remote-resource` (any file of the container, the student's
 * included) only as a sandboxed, unsniffed resource. The full fix, a
 * subdomain per session, is ADR-089's amendment of 2026-10-11.
 */
import type { IncomingHttpHeaders } from "node:http";

import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import type { SessionRow } from "../db/schema.js";
import { checkExamRequest, replyOutsideSeb } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { findAssignment, findSession } from "../sessions/store.js";
import { requestLang, t, type MessageKey } from "../web/i18n.js";
import { errorPage } from "../web/pages.js";

/** Name of the codespace session cookie; carried with `Path=/s/<id>`. */
export const SESSION_COOKIE = "cs_session";

export interface ProxyOptions {
  db: Db;
  manager: SessionManager;
  examCookieSecret: string;
  examCookieMaxAgeMs: number;
}

declare module "fastify" {
  interface FastifyRequest {
    codespaceUpstream: string | null;
  }
}

/** Cookie value: `<sessionId>.<token>`, so that it only serves its own session. */
export function cookieValue(sessionId: string, token: string): string {
  return `${sessionId}.${token}`;
}

export function parseCookieValue(
  raw: string | undefined,
): { sessionId: string; token: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { sessionId: raw.slice(0, dot), token: raw.slice(dot + 1) };
}

/** A refusal page in the reader's language (`web/i18n.ts`). */
function deny(reply: FastifyReply, code: number, title: MessageKey, detail: MessageKey): FastifyReply {
  const lang = requestLang(reply.request);
  return reply
    .code(code)
    .type("text/html; charset=utf-8")
    .send(errorPage(lang, t(lang, title), t(lang, detail)));
}

/** A request on exactly `/s/<id>/`: the student's page reload. */
export function isEntryRequest(url: string, sessionId: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return path === `/s/${sessionId}` || path === `/s/${sessionId}/`;
}

/**
 * The path code-server would route for a request under `/s/<id>`, read as
 * leniently as any router could: percent-decoded, slashes collapsed, dot
 * segments resolved, lower-cased (Express matches case-insensitively). It
 * decides refusals and headers only; what is forwarded is the request as is.
 */
function upstreamPath(url: string): string {
  const raw = (url.split("?", 1)[0] ?? "").replace(/^\/s\/[^/]*/, "");
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // A malformed escape: judge the raw path.
  }
  return new URL(`/${path}`.replace(/\/+/g, "/"), "http://upstream").pathname.toLowerCase();
}

/** code-server's port proxy, `/proxy/<port>/…` and `/absproxy/<port>/…` (L24). */
export function isPortProxyRequest(url: string): boolean {
  return /^\/(abs)?proxy(\/|$)/.test(upstreamPath(url));
}

/**
 * VS Code's remote resource route (`[/stable-<commit>]/vscode-remote-resource
 * ?path=`): it serves any file of the container, `/work` included, with its
 * own media type. The workbench fetches its themes and grammars there.
 */
export function isRemoteResourceRequest(url: string): boolean {
  return upstreamPath(url).split("/").pop() === "vscode-remote-resource";
}

/**
 * What every remote resource answer carries: the headers VS Code 1.137 sets
 * itself (`default-src 'none'; sandbox`, `nosniff`), enforced here so that a
 * student's HTML or SVG opened at that URL never runs on the portal's origin,
 * whatever a later code-server sends. A fetch or an `<img>` ignores them.
 */
export const REMOTE_RESOURCE_HEADERS = {
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
} as const;

/**
 * The headers of code-server's answer as the browser gets them. `Set-Cookie`
 * and `Service-Worker-Allowed` are dropped: a session must not set a cookie
 * nor widen a service worker's scope on the origin every session shares (L24).
 * Under `--auth none` code-server sets no cookie the workbench reads (VS
 * Code's `vscode-tkn`, only on a `?tkn=`, is never checked without a
 * connection token); its own PWA worker then fails to register, which the
 * workbench logs and ignores.
 *
 * `Location`: the internal rewriting of @fastify/http-proxy is wrong for a
 * parameterized prefix (see the registration below); absolute paths are
 * rewritten here, relative ones (code-server's normal case) left alone.
 */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  sessionId: string | undefined,
  url: string,
): IncomingHttpHeaders {
  const { "set-cookie": _cookie, "service-worker-allowed": _worker, ...kept } = headers;
  const location = kept.location;
  if (typeof location === "string" && sessionId && location.startsWith("/") && !location.startsWith("//")) {
    kept.location = `/s/${sessionId}${location}`;
  }
  return isRemoteResourceRequest(url) ? { ...kept, ...REMOTE_RESOURCE_HEADERS } : kept;
}

async function proxyPluginImpl(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const { db, manager } = opts;
  /** sid → `http://<ip>:8080`. Filled by the `preHandler`, read by `getUpstream`. */
  const upstreams = new Map<string, string>();
  /** Sessions whose port proxy refusal was logged: once each, not per request. */
  const portProxyLogged = new Set<string>();

  app.decorateRequest("codespaceUpstream", null);

  async function guard(request: FastifyRequest, reply: FastifyReply) {
    const sessionId = (request.params as { sid?: string }).sid ?? "";
    let session: SessionRow | undefined = findSession(db, sessionId);
    if (!session) {
      return deny(reply, 404, "sessionUnknownTitle", "sessionUnknownDetail");
    }

    const parsed = parseCookieValue(request.cookies[SESSION_COOKIE]);
    if (!parsed || parsed.sessionId !== sessionId || !manager.checkCookie(session, parsed.token)) {
      request.log.warn(
        { sessionId, clientAddress: request.ip },
        "proxy access refused: session cookie missing or invalid",
      );
      return deny(
        reply,
        403,
        "sessionDeniedTitle",
        "sessionDeniedDetail",
      );
    }

    // code-server's port proxy would serve a student's program on the origin
    // every session shares (audit L24). code-server runs with
    // --disable-proxy; this refusal holds even if a later image forgot it.
    if (isPortProxyRequest(request.url)) {
      if (!portProxyLogged.has(sessionId)) {
        if (portProxyLogged.size >= 10_000) portProxyLogged.clear();
        portProxyLogged.add(sessionId);
        request.log.warn({ sessionId, clientAddress: request.ip }, "proxy access refused: code-server port proxy");
      }
      return deny(reply, 403, "portProxyTitle", "portProxyDetail");
    }

    const assignment = findAssignment(db, session.assignmentId);
    if (!assignment) {
      return deny(reply, 404, "unknownAssignment", "assignmentGoneDetail");
    }

    // Exam mode: the SEB cookie, and it alone (invariant 5). A client address
    // different from the one of the initial verification is refused
    // (analyse.md D5).
    if (assignment.mode === "exam") {
      const verdict = checkExamRequest(request, {
        secret: opts.examCookieSecret,
        assignmentId: assignment.id,
        maxAgeMs: opts.examCookieMaxAgeMs,
      });
      if (!verdict.ok) {
        request.log.warn(
          { sessionId, reason: verdict.reason, clientAddress: request.ip },
          "proxy access refused in exam mode",
        );
        return replyOutsideSeb(reply, verdict);
      }
      if (verdict.claims.sessionId !== sessionId) {
        request.log.warn({ sessionId }, "exam cookie from another session");
        return replyOutsideSeb(reply, { ok: false, reason: "address-mismatch" });
      }
    }

    if (session.state === "closed" || session.state === "failed") {
      return deny(
        reply,
        410,
        "sessionClosedTitle",
        "sessionClosedDetail",
      );
    }

    // The page reload is the moment when we check that the container is still
    // there — and where we restart it on the same volume if it is dead
    // (`podman kill`, host reboot). Resource requests and websocket frames do
    // not pay that cost: they make do with the cache, and a dead session shows
    // up on a reload.
    if (isEntryRequest(request.url, sessionId) || !upstreams.has(sessionId)) {
      try {
        session = await manager.ensureRunning(sessionId);
      } catch (err) {
        request.log.error({ sessionId, err }, "session restart impossible");
        return deny(
          reply,
          502,
          "sessionUnavailableTitle",
          "sessionRestartFailed",
        );
      }
    }
    if (!session.containerIp) {
      return deny(reply, 502, "sessionUnavailableTitle", "sessionNoAddress");
    }
    upstreams.set(sessionId, `http://${session.containerIp}:8080`);
    // Heartbeat: it is the proxy that keeps `lastSeen`, so an open tab is
    // enough to keep the session alive, and closing it starts the grace
    // period.
    manager.touch(sessionId);
    return undefined;
  }

  await app.register(httpProxy, {
    prefix: "/s/:sid",
    rewritePrefix: "/",
    upstream: "",
    websocket: true,
    preHandler: guard,
    // The internal `Location` header rewriting of @fastify/http-proxy is wrong
    // for a parameterized prefix: it replaces the rewritten prefix (here the
    // empty string) by the *literal* prefix of the route, and
    // `"./?folder=/work".replace("", "/s/:sid")` produces
    // `"/s/:sid./?folder=/work"` — an unsubstituted `:sid`. We turn it off and
    // rewrite it ourselves in `upstreamHeaders`, touching only absolute paths:
    // code-server serves everything relative (`serverBasePath: "."`), so the
    // normal case does not even need to be rewritten.
    internalRewriteLocationHeader: false,
    replyOptions: {
      getUpstream(request) {
        const sessionId = (request.params as { sid?: string }).sid ?? "";
        return upstreams.get(sessionId) ?? "http://127.0.0.1:1";
      },
      rewriteHeaders(headers, request) {
        const sessionId = (request?.params as { sid?: string } | undefined)?.sid;
        return upstreamHeaders(headers, sessionId, request?.url ?? "");
      },
    },
  });
}

export const proxyPlugin = fp(proxyPluginImpl, { fastify: "5.x", name: "codespace-proxy" });
