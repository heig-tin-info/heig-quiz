/**
 * What the exam side still needs once the platform builds every `.seb` (D21,
 * merge task M6-07): the page of a session outside Safe Exam Browser, and the
 * check the `/s/<session>/*` proxy calls — which reads the `exam_session`
 * cookie and the client address, never a SEB header (invariant 6 of this
 * portal's `CLAUDE.md`). The SEB headers are read once, by `/launch`
 * (`classroom/routes.ts`, through `verify.ts`).
 *
 * The cookie is read by hand rather than with `@fastify/cookie`, so this
 * check works whatever plugins the instance registered. The value
 * `issueExamCookie` emits is base64url, therefore free of characters that
 * would need escaping.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { EXAM_COOKIE, verifyExamCookie, type ExamCookieVerdict } from "./examSession.js";
import { requestLang, t, type Lang } from "../web/i18n.js";
import { escapeHtml, layout } from "../web/pages.js";

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

/**
 * The check the `/s/<session>/*` proxy calls. It looks at **no** SEB header:
 * only at the cookie and the address. Exported here so that `proxy/` does not
 * have to learn the cookie format again.
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
