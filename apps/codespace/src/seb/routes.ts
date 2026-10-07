/**
 * Fastify plugin of the exam side: serving the `.seb` file and verifying the
 * start.
 *
 * Two routes, no dependency on `server.ts`. Everything that comes from the
 * outside — the assignments, the verifier, the session creation — goes through
 * the options, so that the plugin can be tested on its own.
 *
 * The cookie is read and set by hand rather than with `@fastify/cookie`: this
 * plugin has to be registrable in an instance that has already registered the
 * cookie plugin, or has not registered it yet, without causing a decorator
 * collision. The value `issueExamCookie` emits is base64url, therefore free of
 * characters that would need escaping.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import {
  EXAM_COOKIE,
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  issueExamCookie,
  verifyExamCookie,
  type ExamCookieVerdict,
} from "./examSession.js";
import { SEB_CONTENT_TYPE, renderSebFile } from "./sebFile.js";
import type { SebRefusal, SebVerifier } from "./verify.js";
import {
  causeText,
  isBootstrapCause,
  requestLang,
  t,
  type BootstrapCause,
  type Lang,
  type MessageKey,
} from "../web/i18n.js";
import { escapeHtml, layout } from "../web/pages.js";

/** What the portal knows about an assignment in exam mode. */
export interface SebAssignment {
  readonly id: string;
  /** Config Key of the configuration that is served, see sebFile.ts. */
  readonly configKey: string;
  /** One BEK per (platform, version) pair. A list, not a scalar. */
  readonly beks: readonly string[];
  /** Absolute URL of the start route, the one written into the `.seb` file. */
  readonly startUrl: string;
  readonly quitUrl: string;
  readonly examKeySalt: string;
  readonly extraAllowedHosts?: readonly string[];
}

/** Source of the assignments. A `Map` in tests, the database in V1. */
export interface AssignmentLookup {
  find(assignmentId: string): Promise<SebAssignment | undefined> | SebAssignment | undefined;
}

/** Builds a source from a `Map`, for tests and seeds. */
export function mapLookup(assignments: ReadonlyMap<string, SebAssignment>): AssignmentLookup {
  return { find: (id) => assignments.get(id) };
}

export interface StartContext {
  readonly assignment: SebAssignment;
  readonly clientAddress: string;
  readonly request: FastifyRequest;
}

export interface StartOutcome {
  /** Session identifier, written into the cookie. */
  readonly sessionId: string;
  /** Where to redirect to, typically `/s/<sessionId>/`. */
  readonly redirectTo: string;
}

export interface SebRoutesOptions {
  readonly lookup: AssignmentLookup;
  readonly verifier: SebVerifier;
  /** HMAC secret of the exam cookie. */
  readonly cookieSecret: string;
  /** `Secure` on the cookie: false only in cleartext development. */
  readonly cookieSecure?: boolean;
  readonly cookieMaxAgeMs?: number;
  /**
   * Called after a successful verification: creates or resumes the session and
   * returns where to go. Injected so that this plugin does not have to know
   * about `sessions/` nor `engine/`.
   *
   * Optional: without it, `/exam/:assignmentId/start` is not registered at
   * all. The Quiz portal passes none (M6-03): with no login of its own, an
   * exam opens through `/launch` only.
   */
  onStart?(ctx: StartContext): Promise<StartOutcome> | StartOutcome;
}

const REFUSAL_MESSAGES: Record<SebRefusal, MessageKey> = {
  "url-unreconstructible": "sebUrlUnreconstructible",
  "missing-config-key-header": "sebNotFromSeb",
  "missing-request-hash-header": "sebNotFromSeb",
  "config-key-mismatch": "sebConfigKeyMismatch",
  "browser-exam-key-mismatch": "sebBekMismatch",
  "no-browser-exam-key-configured": "sebNoBek",
  "missing-dev-header": "sebNotFromSeb",
};

/** The 403 "session outside SEB" page. Deliberately terse on the student side. */
export function outsideSebPage(lang: Lang, detail: string): string {
  return layout(
    lang,
    t(lang, "outsideSebTitle"),
    "",
    `<p>${escapeHtml(t(lang, "outsideSebIntro"))}</p>
<p>${escapeHtml(detail)}</p>
<p>${escapeHtml(t(lang, "outsideSebHelp"))}</p>`,
  );
}

/**
 * Refusal to start an exam for a cause that has nothing to do with SEB: the
 * statement could not be placed in the workspace. The student is not
 * redirected to an empty room — the invigilator is called.
 */
export function workspacePage(lang: Lang, cause: BootstrapCause): string {
  return layout(
    lang,
    t(lang, "examUnavailableTitle"),
    "",
    `<p>${escapeHtml(t(lang, "examWorkspaceDetail", { cause: causeText(lang, cause) }))}</p>`,
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function serialiseCookie(
  name: string,
  value: string,
  options: { maxAgeMs: number; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    // `Lax`: SEB reaches /start through a top-level navigation.
    "SameSite=Lax",
    `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

async function sebRoutesPlugin(app: FastifyInstance, options: SebRoutesOptions): Promise<void> {
  const maxAgeMs = options.cookieMaxAgeMs ?? EXAM_COOKIE_DEFAULT_MAX_AGE_MS;
  const secure = options.cookieSecure ?? true;
  const unknown = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    reply
      .code(404)
      .type("text/plain; charset=utf-8")
      .send(`${t(requestLang(request), "unknownAssignment")}\n`);

  app.get<{ Params: { assignmentId: string } }>(
    "/exam/:assignmentId.seb",
    async (request, reply) => {
      const assignment = await options.lookup.find(request.params.assignmentId);
      if (assignment === undefined) return unknown(request, reply);
      const file = renderSebFile({
        startUrl: assignment.startUrl,
        quitUrl: assignment.quitUrl,
        examKeySalt: assignment.examKeySalt,
        ...(assignment.extraAllowedHosts !== undefined
          ? { extraAllowedHosts: assignment.extraAllowedHosts }
          : {}),
      });
      return reply
        .code(200)
        .header("content-type", SEB_CONTENT_TYPE)
        .header("content-disposition", 'attachment; filename="config.seb"')
        .header("cache-control", "private, max-age=1, no-transform")
        .send(file.xml);
    },
  );

  const onStart = options.onStart;
  if (onStart === undefined) return;

  app.get<{ Params: { assignmentId: string } }>(
    "/exam/:assignmentId/start",
    async (request, reply) => {
      const lang = requestLang(request);
      const assignment = await options.lookup.find(request.params.assignmentId);
      if (assignment === undefined) return unknown(request, reply);

      const verdict = options.verifier.verifyStart(
        { url: request.url, headers: request.headers },
        { configKey: assignment.configKey, beks: assignment.beks },
      );

      if (!verdict.ok) {
        // The reason is logged, never a BEK nor a SEB header: the headers
        // received are hashes of the shared secret, and the list of accepted
        // BEKs must not appear anywhere in the logs.
        request.log.warn(
          {
            seb: {
              assignmentId: assignment.id,
              reason: verdict.reason,
              mode: options.verifier.mode,
              clientAddress: request.ip,
              url: verdict.url,
            },
          },
          "exam start refused",
        );
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(outsideSebPage(lang, t(lang, REFUSAL_MESSAGES[verdict.reason])));
      }

      let outcome: StartOutcome;
      try {
        outcome = await onStart({
          assignment,
          clientAddress: request.ip,
          request,
        });
      } catch (err) {
        // An `onStart` may refuse for a reason that has nothing to do with
        // SEB: the workspace could not be prepared (`sessions/manager.ts`,
        // `WorkspaceBootstrapError`). The exam side does not know that module
        // — the short cause is read structurally, not by type, which keeps the
        // boundary intact.
        const cause = (err as { shortCause?: unknown } | null)?.shortCause;
        if (!isBootstrapCause(cause)) throw err;
        request.log.warn(
          { seb: { assignmentId: assignment.id, clientAddress: request.ip }, cause },
          "exam start refused: workspace could not be prepared",
        );
        return reply.code(503).type("text/html; charset=utf-8").send(workspacePage(lang, cause));
      }

      const cookie = issueExamCookie(
        {
          assignmentId: assignment.id,
          sessionId: outcome.sessionId,
          clientAddress: request.ip,
          issuedAt: Date.now(),
        },
        { secret: options.cookieSecret, maxAgeMs: maxAgeMs },
      );

      request.log.info(
        {
          seb: {
            assignmentId: assignment.id,
            sessionId: outcome.sessionId,
            mode: options.verifier.mode,
            clientAddress: request.ip,
          },
        },
        "exam start accepted",
      );

      return reply
        .header("set-cookie", serialiseCookie(EXAM_COOKIE, cookie, { maxAgeMs, secure }))
        .redirect(outcome.redirectTo, 303);
    },
  );
}

export const sebRoutes = fp(sebRoutesPlugin, {
  fastify: "5.x",
  name: "seb-routes",
});

/**
 * The check the `/s/<session>/*` proxy will call. It looks at **no** SEB header
 * (invariant 5): only at the cookie and the address. Exported here so that
 * `proxy/` does not have to learn the cookie format again.
 */
export function checkExamRequest(
  request: FastifyRequest,
  check: { secret: string; assignmentId?: string; maxAgeMs?: number },
): ExamCookieVerdict {
  return verifyExamCookie(readCookie(request.headers.cookie, EXAM_COOKIE), {
    secret: check.secret,
    clientAddress: request.ip,
    ...(check.assignmentId !== undefined ? { assignmentId: check.assignmentId } : {}),
    ...(check.maxAgeMs !== undefined ? { maxAgeMs: check.maxAgeMs } : {}),
  });
}

/** The proxy's single 403 response, so that the message does not vary with the route. */
export function replyOutsideSeb(reply: FastifyReply, verdict: ExamCookieVerdict): FastifyReply {
  const lang = requestLang(reply.request);
  const detail = t(
    lang,
    verdict.ok === false && verdict.reason === "address-mismatch"
      ? "sebOtherMachine"
      : "sebNoExamSession",
  );
  return reply.code(403).type("text/html; charset=utf-8").send(outsideSebPage(lang, detail));
}

export { readCookie as readExamCookieFrom };
