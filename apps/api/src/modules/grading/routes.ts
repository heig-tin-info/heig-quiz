/**
 * HTTP surface of the `grading` module (PLAN-MVP §4.5).
 *
 * Teacher only, from the first line to the last: nothing here is reachable
 * with a student session, and an evaluation another teacher owns answers 404,
 * never 403 (invariant 6). Every body is parsed by a schema from
 * `@quiz/contracts` (invariant 7) and every write is audited (invariant 9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";

import {
  AnswerIdParam,
  BatchValidateBody,
  GradingIdParam,
  GradingQuery,
  GradingRunBody,
  IdParam,
  ItemParam,
  type GradingRunAccepted,
  ManualGradingBody,
  RegradeBody,
  ValidateGradingBody,
} from "@quiz/contracts";

import { tracer, type AuditAction } from "../../audit.js";
import { gradings, questionVersions } from "../../db/schema.js";
import { loadEvaluation, staffAnswer, staffGrading, teacherGuard } from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import { joinedItems, retargetItemVersion } from "../evaluation/service.js";
import { markModifiedAfterRelease } from "../results/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";

export async function gradingPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** Maps every failure of the module to its status; the rest is a 500. */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof service.GradingError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "grading route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  /** Params, scope, then body: access is loaded before anything else is checked (invariant 6). */
  const teacher = teacherRoute(app, failure);

  const trace = tracer(app);

  // The loaders of invariant 6, each answering its own 404.
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const answerOf = (req: FastifyRequest, reply: FastifyReply, p: { answerId: string }) =>
    staffAnswer(app, req, reply, p.answerId);
  const gradingOf = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    staffGrading(app, req, reply, p.id);

  // --- The automatic pass ------------------------------------------------

  /**
   * `POST /evaluations/:id/grading/run`. The job is a singleton per evaluation
   * and skips every cell that already has a validated grading, so pressing the
   * button twice costs one pass and changes nothing that a teacher settled.
   */
  app.post(
    "/app/api/evaluations/:id/grading/run",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: GradingRunBody, optionalBody: true, load: staffEvaluation },
      async ({ req, reply, body, scope }) => {
        const items = await joinedItems(app.db, scope.evaluation.id);
        const known = new Set(items.map((i) => i.item.id));
        const itemIds = (body.itemIds ?? [...known]).filter((id) => known.has(id));
        const queued = await enqueueEvaluationGrading(app, {
          evaluationId: scope.evaluation.id,
          ...(body.itemIds ? { itemIds } : {}),
        });
        await trace(req, "grading.run", "evaluation", scope.evaluation.id, { itemIds });
        return reply
          .code(202)
          .send({
            evaluationId: scope.evaluation.id,
            itemIds,
            queued,
          } satisfies GradingRunAccepted);
      },
    ),
  );

  app.get(
    "/app/api/evaluations/:id/grading/progress",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.progressOf(app.db, scope.evaluation.id),
    ),
  );

  // --- The panel ---------------------------------------------------------

  app.get(
    "/app/api/evaluations/:id/grading",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, query: GradingQuery, load: staffEvaluation }, ({ query, scope }) =>
      service.gradingQueue(app.db, scope.evaluation, query),
    ),
  );

  /** The whole history of one answer, newest first (F-GRADE-05). */
  app.get(
    "/app/api/answers/:answerId/gradings",
    { preHandler: requireTeacher },
    teacher({ params: AnswerIdParam, load: answerOf }, ({ scope }) =>
      service.historyOfCell(app.db, scope.answer.attemptId, scope.answer.itemId),
    ),
  );

  // --- Manual correction -------------------------------------------------

  /**
   * F-GRADE-05: the override, with its mandatory comment. Two entry points
   * for one correction (B-10): the cell is found from the answer here, and
   * from the grading below.
   */
  async function applyOverride(
    req: FastifyRequest,
    evaluation: Parameters<typeof events.gradingChanged>[0],
    cell: Parameters<typeof service.manualOverride>[1],
    body: ManualGradingBody,
    now: Date,
  ) {
    const row = await service.manualOverride(
      app.db,
      cell,
      {
        points: body.points,
        comment: body.comment,
        ...(body.details === undefined ? {} : { details: body.details }),
      },
      req.user!.id,
      now,
    );
    await afterCorrection(req, evaluation, row, "grading.override");
    return service.toGrading(row);
  }

  app.post(
    "/app/api/answers/:answerId/gradings",
    { preHandler: requireTeacher },
    teacher(
      {
        params: AnswerIdParam,
        body: ManualGradingBody,
        load: async (req, reply, p) => {
          const scope = await answerOf(req, reply, p);
          if (!scope) return null;
          const cell = await service.cellOfAnswer(app.db, p.answerId);
          if (cell) return { evaluation: scope.evaluation, cell };
          await notFound(reply);
          return null;
        },
      },
      ({ req, now, body, scope }) => applyOverride(req, scope.evaluation, { ...scope.cell }, body, now),
    ),
  );

  /**
   * The same override for a cell that has NO answer row: F-GRADE-01 grades an
   * absent answer, so the panel shows an entry the plan's `/answers/:id` path
   * cannot address (deviation W6-3).
   */
  app.post(
    "/app/api/gradings/:id/override",
    { preHandler: requireTeacher },
    teacher(
      { params: GradingIdParam, body: ManualGradingBody, load: gradingOf },
      ({ req, now, body, scope }) =>
        applyOverride(
          req,
          scope.evaluation,
          {
            attemptId: scope.grading.attemptId,
            itemId: scope.grading.itemId,
            answerId: scope.grading.answerId,
            maxPoints: scope.grading.maxPoints,
          },
          body,
          now,
        ),
    ),
  );

  /** F-GRADE-04: validating one proposal, possibly adjusting it on the way. */
  app.post(
    "/app/api/gradings/:id/validate",
    { preHandler: requireTeacher },
    teacher(
      { params: GradingIdParam, body: ValidateGradingBody, optionalBody: true, load: gradingOf },
      async ({ req, now, body, scope }) => {
        const row = await service.validateGrading(app.db, scope.grading, body, req.user!.id, now);
        await afterCorrection(req, scope.evaluation, row, "grading.validate");
        return service.toGrading(row);
      },
    ),
  );

  /** F-GRADE-04: the filtered batch ("every high-confidence proposal of q3"). */
  app.post(
    "/app/api/evaluations/:id/grading/validate-batch",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: BatchValidateBody, optionalBody: true, load: staffEvaluation },
      async ({ req, now, body, scope }) => {
        const validated = await service.batchValidate(
          app.db,
          scope.evaluation.id,
          body,
          req.user!.id,
          now,
        );
        if (validated > 0) {
          await markModifiedAfterRelease(app.db, scope.evaluation, now);
          await trace(req, "grading.validate", "evaluation", scope.evaluation.id, {
            ...body,
            validated,
          });
          events.gradingChanged(scope.evaluation);
        }
        return { validated };
      },
    ),
  );

  // --- Regrade (F-GRADE-06) ----------------------------------------------

  /**
   * Re-grades ONE item across every attempt. Optionally repoints the item at
   * a newer published version first; every grading the pass writes carries
   * `regrade_note`, and the ones it replaces become `superseded`.
   */
  app.post(
    "/app/api/evaluations/:id/items/:itemId/regrade",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: RegradeBody, load: staffEvaluation },
      async ({ req, reply, now, params, body, scope }) => {
        const items = await joinedItems(app.db, scope.evaluation.id);
        const item = items.find((i) => i.item.id === params.itemId);
        if (!item) return notFound(reply);

        let note = body.note.trim();
        if (body.toVersionNumber !== undefined) {
          const [version] = await app.db
            .select({ id: questionVersions.id })
            .from(questionVersions)
            .where(
              and(
                eq(questionVersions.questionId, item.question.id),
                eq(questionVersions.number, body.toVersionNumber),
              ),
            )
            .limit(1);
          if (!version) return notFound(reply);
          await retargetItemVersion(app.db, item.item.id, version.id);
          note = `${note} (re-graded with version ${body.toVersionNumber})`;
        }

        // The pass skips a cell that already holds a validated grading, so a
        // regrade starts by standing everything down. Nothing is deleted: the
        // history of §4.5 is the whole chain.
        await app.db
          .update(gradings)
          .set({ state: "superseded" })
          .where(and(eq(gradings.itemId, item.item.id), ne(gradings.state, "superseded")));

        const queued = await enqueueEvaluationGrading(app, {
          evaluationId: scope.evaluation.id,
          itemIds: [item.item.id],
          regradeNote: note,
        });
        const modified = await markModifiedAfterRelease(app.db, scope.evaluation, now);
        await trace(req, "grading.regrade", "evaluation", scope.evaluation.id, {
          itemId: item.item.id,
          note,
          toVersionNumber: body.toVersionNumber ?? null,
          modifiedAfterRelease: modified,
        });
        events.gradingChanged(scope.evaluation);
        return reply
          .code(202)
          .send({ evaluationId: scope.evaluation.id, itemIds: [item.item.id], queued });
      },
    ),
  );

  /** What every single-cell correction does afterwards, in one place. */
  async function afterCorrection(
    req: FastifyRequest,
    evaluation: Parameters<typeof events.gradingChanged>[0],
    row: service.GradingRecord,
    action: AuditAction,
  ): Promise<void> {
    await markModifiedAfterRelease(app.db, evaluation, app.clock.now());
    await trace(req, action, "grading", row.id, {
      evaluationId: evaluation.id,
      attemptId: row.attemptId,
      itemId: row.itemId,
      points: row.points,
    });
    events.gradingChanged(evaluation);
  }
}
