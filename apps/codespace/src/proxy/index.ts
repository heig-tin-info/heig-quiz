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
 * Audit L24: what a session may serve on the origin every session shares is
 * portal invariant 14 (CLAUDE.md) and ADR-047's amendment of 2026-10-11.
 */
import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import type { SessionRow } from "../db/schema.js";
import { checkExamRequest, replyOutsideSeb } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { isSittingClosed, type SittingSockets } from "../sessions/sittings.js";
import { findAssignment, findSession, isReview } from "../sessions/store.js";
import { requestLang, t, type MessageKey } from "../web/i18n.js";
import { errorPage } from "../web/pages.js";

/** Name of the codespace session cookie; carried with `Path=/s/<id>`. */
export const SESSION_COOKIE = "cs_session";

export interface ProxyOptions {
  db: Db;
  manager: SessionManager;
  examCookieSecret: string;
  examCookieMaxAgeMs: number;
  /** Where each socket upgraded under a kiosk sitting is tagged, for its close (ADR-089). */
  sittingSockets: SittingSockets;
  /** code-server's port in the container; 8080 (tests point it at a local upstream). */
  upstreamPort?: number;
  /** Where a refusal page sends the reader back: the platform (`PLATFORM_URL`); the portal's `/` without it. */
  platformUrl?: string;
  /** How long open websockets alone keep a session, from its last page load (`SESSION_MAX_HELD_MS`). */
  maxHeldMs: number;
}

/** code-server's port inside the student container (`images/c-dev`). */
export const CODE_SERVER_PORT = 8080;

/**
 * How often an open websocket counts as a heartbeat (#1101). code-server's
 * traffic after the first load is websocket frames, which the `preHandler`
 * never sees: without this, an open tab looked idle `SESSION_GRACE_MS` after
 * its last HTTP request, and `collect` closed it under the student's feet.
 * Well under the grace period (10 minutes in production).
 */
export const SOCKET_HEARTBEAT_MS = 30_000;

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

/** A refusal page in the reader's language (`web/i18n.ts`), its link back to `back`. */
function deny(reply: FastifyReply, code: number, title: MessageKey, detail: MessageKey, back?: string): FastifyReply {
  const lang = requestLang(reply.request);
  return reply
    .code(code)
    .type("text/html; charset=utf-8")
    .send(errorPage(lang, t(lang, title), t(lang, detail), back));
}

/** A request on exactly `/s/<id>/`: the student's page reload. */
export function isEntryRequest(url: string, sessionId: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return path === `/s/${sessionId}` || path === `/s/${sessionId}/`;
}

/**
 * code-server's port proxy, `/proxy/<port>/…` and `/absproxy/<port>/…`.
 * Express routes it on the raw path, case-insensitively, decoding nothing;
 * @fastify/http-proxy refuses a `..` or `//` destination. Never throws.
 */
export function isPortProxyRequest(url: string): boolean {
  return /^\/s\/[^/]+\/+(abs)?proxy(\/|$)/i.test(url.split("?", 1)[0] ?? "");
}

/**
 * VS Code's remote resource route (`[/stable-<commit>]/vscode-remote-resource
 * ?path=`), which serves any file of the container with its own media type.
 * A miss only falls back to VS Code's own, identical, headers.
 */
export function isRemoteResourceRequest(url: string): boolean {
  return (url.split("?", 1)[0] ?? "").split("/").pop() === "vscode-remote-resource";
}

/** Sandboxed and unsniffed: a document opened there runs no script. */
const REMOTE_RESOURCE_HEADERS = {
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
} as const;

/**
 * code-server's answer headers as the browser gets them: no `Set-Cookie`, no
 * `Service-Worker-Allowed` (code-server's only cookie, `vscode-tkn`, is never
 * read without a connection token; its no-op PWA worker stops registering).
 * An absolute `Location` is rewritten into the session (see `internalRewriteLocationHeader`).
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
  /** sid → its open websockets: a connected tab is a live one (#1101). */
  const sockets = new Map<string, number>();
  /** Sockets already counted: a socket is counted once, whatever comes through it. */
  const counted = new WeakSet<Socket>();
  /**
   * sid → its last page load, while it has sockets: past `maxHeldMs`, open
   * sockets alone no longer keep it (a forgotten tab). A reload renews it, a
   * websocket reconnect does not; after a restart, the first socket counts as now.
   */
  const loadedAt = new Map<string, number>();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const sessionId of sockets.keys()) {
      if (now - (loadedAt.get(sessionId) ?? now) < opts.maxHeldMs) manager.touch(sessionId);
    }
  }, SOCKET_HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));
  const back = opts.platformUrl;

  /** Counts `socket` for `sessionId` until it closes; the grace period starts then. */
  function holdWhileOpen(sessionId: string, socket: Socket): void {
    if (counted.has(socket) || socket.destroyed) return;
    counted.add(socket);
    sockets.set(sessionId, (sockets.get(sessionId) ?? 0) + 1);
    if (!loadedAt.has(sessionId)) loadedAt.set(sessionId, Date.now());
    socket.once("close", () => {
      const left = (sockets.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        sockets.set(sessionId, left);
        return;
      }
      sockets.delete(sessionId);
      // Past the cap, the close does not renew the session either.
      if (Date.now() - (loadedAt.get(sessionId) ?? 0) < opts.maxHeldMs) manager.touch(sessionId);
      loadedAt.delete(sessionId);
    });
  }

  app.decorateRequest("codespaceUpstream", null);

  /** A station whose sitting Quiz closed: the station's words, not the SEB page (ADR-089). */
  function sittingClosed(request: FastifyRequest, reply: FastifyReply, sessionId: string, sitting: string): FastifyReply {
    request.log.warn({ sessionId, sitting, clientAddress: request.ip }, "proxy access refused: kiosk sitting closed");
    return deny(reply, 403, "sessionClosedTitle", "launchSittingClosed");
  }

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
        back,
      );
    }

    // Invariant 14: code-server runs with --disable-proxy; this holds if an image forgets it.
    if (isPortProxyRequest(request.url)) {
      request.log.warn({ sessionId, clientAddress: request.ip }, "proxy access refused: code-server port proxy");
      return deny(reply, 403, "portProxyTitle", "portProxyDetail");
    }

    const assignment = findAssignment(db, session.assignmentId);
    if (!assignment) {
      return deny(reply, 404, "unknownAssignment", "assignmentGoneDetail");
    }

    // Exam mode: the SEB cookie, and it alone (invariant 5). A client address
    // different from the one of the initial verification is refused
    // (analyse.md D5). A station's cookie carries its sitting: once Quiz
    // closed that sitting, the cookie is revoked (ADR-089).
    let sitting: string | undefined;
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
      sitting = verdict.claims.sitting;
      if (sitting !== undefined && isSittingClosed(db, sitting)) return sittingClosed(request, reply, sessionId, sitting);
    }

    if (session.state === "closed" || session.state === "failed") {
      return deny(
        reply,
        410,
        "sessionClosedTitle",
        // A review session keeps nothing (ADR-129 §10): no "your work is kept".
        isReview(assignment) ? "reviewClosedDetail" : "sessionClosedDetail",
        back,
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
    upstreams.set(sessionId, `http://${session.containerIp}:${opts.upstreamPort ?? CODE_SERVER_PORT}`);
    // A websocket upgraded under a station's cookie is tagged with its
    // sitting: the close drops it, whoever holds the session by then.
    if (sitting !== undefined && request.headers.upgrade !== undefined) {
      opts.sittingSockets.track(sitting, request.raw.socket);
      // Checked again once tagged: a close that landed during the awaits
      // above (`ensureRunning`) either wrote its row before this read, or
      // ran its `drop` after the tag. Either way the socket does not survive.
      if (isSittingClosed(db, sitting)) return sittingClosed(request, reply, sessionId, sitting);
    }
    // Heartbeat: it is the proxy that keeps `lastSeen`, so an open tab is
    // enough to keep the session alive, and closing it starts the grace
    // period. An HTTP request counts once; a websocket for as long as it is
    // open, counted only here, after every refusal above.
    manager.touch(sessionId);
    if (isEntryRequest(request.url, sessionId)) loadedAt.set(sessionId, Date.now());
    // The upgrade path only: Node hands a request to it on `Connection: upgrade`.
    if (/\bupgrade\b/i.test(request.headers.connection ?? "") && request.headers.upgrade?.toLowerCase() === "websocket") {
      holdWhileOpen(sessionId, request.raw.socket);
    }
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
