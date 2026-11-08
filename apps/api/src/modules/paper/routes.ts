/**
 * HTTP surface of the `paper` module (ADR-125 §9–§16): staff routes only.
 *
 * Every route loads the evaluation through `loadEvaluation` — any member of
 * the course's staff, an admin's Super Powers included (`staffAccess`,
 * invariant 6); a stranger gets the 404 of a missing evaluation. The
 * attempt routes load the attempt through `loadEvaluationAttempt`, and a
 * digital attempt has no sheet: the same 404.
 */
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AttemptParam,
  IdParam,
  PaperAttemptBody,
  PaperItemsQuery,
  type PaperAttemptCreated,
} from "@quiz/contracts";

import { readTracer, tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { loadEvaluation, loadEvaluationAttempt, teacherGuard, userOf } from "../guards.js";
import { teacherRoute } from "../http.js";
import { liveFailureArms } from "../live/service.js";
import * as service from "./service.js";

export async function paperPlugin(
  app: FastifyInstance,
  opts: { config: Pick<AppConfig, "ASSETS_DIR" | "PAPER_SCAN_MAX_BYTES"> },
) {
  const { config } = opts;
  // Past the cap, `toBuffer()` throws Fastify's `FST_REQ_FILE_TOO_LARGE`: a 413.
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.PAPER_SCAN_MAX_BYTES, files: 1, fields: 4 },
  });

  const requireTeacher = teacherGuard(app);
  // `liveFailureArms`: a refused answer is the save's `422 answer_invalid`, with its issues.
  const teacher = teacherRoute(app, liveFailureArms);
  const trace = tracer(app);
  const traceRead = readTracer(app);
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const staffEvaluationAttempt = loadEvaluationAttempt(app);

  /** The entry page's paper: the student views of the hand-out's order, and the key. */
  app.get(
    "/app/api/evaluations/:id/paper/items",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, query: PaperItemsQuery, load: staffEvaluation }, ({ now, query, scope }) =>
      service.paperItems(app.db, scope.evaluation, query.user, now),
    ),
  );

  /** F-PAPER-01: one student's whole copy, handed in once. */
  app.post(
    "/app/api/evaluations/:id/paper",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PaperAttemptBody, load: staffEvaluation },
      async ({ req, reply, now, body, scope }) => {
        const inserted = await service.enterPaperCopy(app, scope.evaluation, body, userOf(req).id, now);
        const supersededAttemptId = inserted.superseded[0] ?? null;
        await trace(req, "paper.enter", "attempt", inserted.attempt.id, {
          evaluationId: scope.evaluation.id,
          userId: body.userId,
          examDate: body.examDate,
          ...(supersededAttemptId === null ? {} : { supersededAttemptId }),
        });
        const created: PaperAttemptCreated = { attemptId: inserted.attempt.id, supersededAttemptId };
        return reply.code(201).send(created);
      },
    ),
  );

  /** The sheet of a paper attempt: its exam date and its scan, if any. */
  app.get(
    "/app/api/evaluations/:id/attempts/:attemptId/paper",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, ({ scope }) =>
      service.paperSheet(app.db, scope.attempt.id),
    ),
  );

  /** F-PAPER-04: attaches the scan, or replaces it. Multipart, one file. */
  app.put(
    "/app/api/evaluations/:id/attempts/:attemptId/paper/scan",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, reply, now, scope }) => {
      if (!req.isMultipart()) {
        return reply.code(415).send({ error: "unsupported_media_type", message: "Expected multipart/form-data" });
      }
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "validation", message: "No file in the request" });
      const bytes = await part.toBuffer();
      const sheet = await service.attachScan(app.db, config.ASSETS_DIR, scope.attempt.id, bytes, userOf(req).id, now);
      await trace(req, "paper.scan_upload", "attempt", scope.attempt.id, {
        evaluationId: scope.evaluation.id,
        mime: sheet.scan?.mime,
        bytes: sheet.scan?.bytes,
      });
      return sheet;
    }),
  );

  /** The scan, to save: staff only, never inline, never sniffed; each opening audited. */
  app.get(
    "/app/api/evaluations/:id/attempts/:attemptId/paper/scan",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, reply, scope }) => {
      const scan = await service.readScan(app.db, config.ASSETS_DIR, scope.attempt.id);
      await traceRead(req, "paper.scan_read", "attempt", scope.attempt.id, { evaluationId: scope.evaluation.id });
      return reply
        .type(scan.mime)
        .header("content-disposition", `attachment; filename="${scan.filename}"`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .send(scan.bytes);
    }),
  );
}
