/**
 * HTTP surface of the `privacy` module (N-DATA-04, ADR-112): the personal
 * data export, one synchronous download built in the request and stored
 * nowhere; and the student's two documents beside it (ADR-112 amendment of
 * 2026-11-03): their own copy of an attempt and the blank print of a past
 * series.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { HandoutRecord, IdParam, PERSONAL_DATA_EXPORT_PATH, personalDataExportFileName, StudentCopyRecord } from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { sendExport } from "../../documents/files.js";
import { FixedWindowLimiter } from "../../limiter.js";
import { codespaceOn } from "../codespace/service.js";
import { handout, handoutTree } from "../evaluation/service.js";
import { callerOf, ownAttempt, ownSessionGuard } from "../guards.js";
import { DomainError, notFound, rateLimited, readerLang, studentRoute } from "../http.js";
import { studentCopyDocument, studentCopyRecord } from "../results/service.js";
import { findPastSeries, STUDENT_DOCUMENTS_PER_HOUR } from "./documents.js";
import { exportCounts, personalDataExport } from "./service.js";

/** ADR-112 §8: five files per person and hour, per process (best effort). */
export const EXPORTS_PER_HOUR = 5;

const HOUR_MS = 3_600_000;

export async function privacyPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const exports = new FixedWindowLimiter(EXPORTS_PER_HOUR, HOUR_MS);
  /** The student's documents, both together, apart from `exports`. */
  const documents = new FixedWindowLimiter(STUDENT_DOCUMENTS_PER_HOUR, HOUR_MS);
  const trace = tracer(app);
  const student = studentRoute(app);
  /** The caller's own portal session only: never an impersonation, a `seb` or `kiosk` session, nor a Bearer token. */
  const own = { preHandler: ownSessionGuard(app) };
  /** The past series `p.id`, for the caller's own session, answering the 404 (invariant 6). */
  const pastSeries = async (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => {
    const found = await findPastSeries(app.db, callerOf(req), req.auth, p.id);
    if (found === null) await notFound(reply);
    return found;
  };

  /** `429 rate_limited` with its `retry-after` once the caller's documents of the hour are spent; counts nothing. */
  const assertBucket = (req: FastifyRequest, now: Date) => {
    const wait = documents.wait(callerOf(req).id, now.getTime());
    if (wait !== null) throw new DomainError("rate_limited", 429, "too many documents in an hour", undefined, wait);
  };
  /**
   * A document delivered: counted in the bucket and audited, once its body
   * exists — a refusal (409) or a PDF the server could not make (503) costs
   * the caller nothing and leaves no row.
   */
  const delivered = (req: FastifyRequest, now: Date, payload: Record<string, string>) => async () => {
    documents.hit(callerOf(req).id, now.getTime());
    await trace(req, "privacy.export", "user", callerOf(req).id, payload);
  };

  /**
   * The caller's own portal session only (`ownSessionGuard`): never an
   * impersonation, a `seb` or `kiosk` session, nor a Bearer token. A failure
   * of any section is a 500, never a partial file.
   */
  app.get(PERSONAL_DATA_EXPORT_PATH, own, async (req, reply) => {
    const now = app.clock.now();
    const caller = callerOf(req);
    const wait = exports.hit(caller.id, now.getTime());
    if (wait !== null) return rateLimited(reply, wait);
    const file = await personalDataExport(
      app.db,
      { caller, user: req.user! },
      now,
      { lang: readerLang(req), codespace: codespaceOn(opts.config) },
    );
    await trace(req, "privacy.export", "user", caller.id, exportCounts(file));
    return reply
      .type("application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="${personalDataExportFileName(file.generatedAt)}"`)
      .header("cache-control", "no-store")
      .send(JSON.stringify(file));
  });

  /**
   * The student's own copy of a handed-in attempt (F-EXP-06): what its
   * feedback page shows, as a file — `409 feedback_pending` while the page
   * shows nothing, `409 practice_attempt` for a practice one. The attempt is
   * the caller's own (`ownAttempt`), so a teacher reaches only their own
   * staff test attempt here.
   */
  for (const format of ["json", "pdf"] as const) {
    app.get(
      `/app/api/attempts/:id/copy.${format}`,
      own,
      student(
        { params: IdParam, load: (req, reply, p) => ownAttempt(app, req, reply, p.id) },
        async ({ req, reply, now, scope }) => {
          assertBucket(req, now);
          const found = await studentCopyRecord(app.db, scope.evaluation, scope.attempt, { now });
          const lang = readerLang(req);
          return sendExport(
            reply,
            format,
            found,
            StudentCopyRecord,
            () => studentCopyDocument(found, lang),
            delivered(req, now, { kind: "student-copy", attemptId: scope.attempt.id }),
          );
        },
      ),
    );
  }

  /**
   * The blank print of a past series (ADR-122 §9): the hand-out, the
   * statements through the student exit in the evaluation's paper order
   * (ADR-125 §8), no answer, no key. `409 not_printable` where the
   * evaluation does not print (ADR-125 §5). PDF only: the record is the
   * staff export sheet's.
   */
  app.get(
    "/app/api/student/evaluations/:id/handout.pdf",
    own,
    student({ params: IdParam, load: pastSeries }, async ({ req, reply, now, scope }) => {
      assertBucket(req, now);
      const found = await handout(app.db, scope, { now });
      const lang = readerLang(req);
      return sendExport(
        reply,
        "pdf",
        found,
        HandoutRecord,
        () => handoutTree(found, lang),
        delivered(req, now, { kind: "handout", evaluationId: scope.id }),
      );
    }),
  );
}
