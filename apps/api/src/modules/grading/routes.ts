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
  ItemParam,
  type GradingRunAccepted,
  ManualGradingBody,
  RegradeBody,
  ValidateGradingBody,
} from "@quiz/contracts";

import { tracer, type AuditAction } from "../../audit.js";
import { evaluationItems, gradings, questionVersions } from "../../db/schema.js";
import {
  accessibleEvaluation,
  loadEvaluation,
  staffAnswer,
  staffGrading,
  teacherGuard,
} from "../guards.js";
import { emptyBody, invalid } from "../http.js";
import { joinedItems } from "../evaluation/service.js";
import { markModifiedAfterRelease } from "../results/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";

function failure(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof service.GradingError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  app.log.error({ err: error }, "grading route failed");
  return reply.code(500).send({ error: "internal_error" });
}

export async function gradingPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  const trace = tracer(app);

  // --- The automatic pass ------------------------------------------------

  /**
   * `POST /evaluations/:id/grading/run`. The job is a singleton per evaluation
   * and skips every cell that already has a validated grading, so pressing the
   * button twice costs one pass and changes nothing that a teacher settled.
   */
  const runHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = GradingRunBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const items = await joinedItems(app.db, scope.evaluation.id);
    const known = new Set(items.map((i) => i.item.id));
    const itemIds = (body.data.itemIds ?? [...known]).filter((id) => known.has(id));
    const queued = await enqueueEvaluationGrading(app, {
      evaluationId: scope.evaluation.id,
      ...(body.data.itemIds ? { itemIds } : {}),
    });
    await trace(req, "grading.run", "evaluation", scope.evaluation.id, { itemIds });
    return reply
      .code(202)
      .send({
        evaluationId: scope.evaluation.id,
        itemIds,
        queued,
      } satisfies GradingRunAccepted);
  };

  app.post("/app/api/evaluations/:id/grading/run", { preHandler: requireTeacher }, runHandler);

  app.get(
    "/app/api/evaluations/:id/grading/progress",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      return service.progressOf(app.db, scope.evaluation.id);
    },
  );

  // --- The panel ---------------------------------------------------------

  app.get("/app/api/evaluations/:id/grading", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const query = GradingQuery.safeParse(req.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    return service.gradingQueue(app.db, scope.evaluation, query.data);
  });

  /** The whole history of one answer, newest first (F-GRADE-05). */
  app.get("/app/api/answers/:answerId/gradings", { preHandler: requireTeacher }, async (req, reply) => {
    const params = AnswerIdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const scope = await staffAnswer(app, req, reply, params.data.answerId);
    if (!scope) return reply;
    return service.historyOfCell(app.db, scope.answer.attemptId, scope.answer.itemId);
  });

  // --- Manual correction -------------------------------------------------

  /** F-GRADE-05: the override, with its mandatory comment. */
  app.post(
    "/app/api/answers/:answerId/gradings",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = AnswerIdParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = ManualGradingBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const scope = await staffAnswer(app, req, reply, params.data.answerId);
      if (!scope) return reply;
      const cell = await service.cellOfAnswer(app.db, params.data.answerId);
      if (!cell) return reply.code(404).send({ error: "not_found" });
      try {
        const row = await service.manualOverride(
          app.db,
          { ...cell },
          {
            points: body.data.points,
            comment: body.data.comment,
            ...(body.data.details === undefined ? {} : { details: body.data.details }),
          },
          req.user!.id,
          now,
        );
        await afterCorrection(req, scope.evaluation, row, "grading.override");
        return service.toGrading(row);
      } catch (error) {
        return failure(app, reply, error);
      }
    },
  );

  /**
   * The same override for a cell that has NO answer row: F-GRADE-01 grades an
   * absent answer, so the panel shows an entry the plan's `/answers/:id` path
   * cannot address (deviation W6-3).
   */
  app.post("/app/api/gradings/:id/override", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const params = GradingIdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = ManualGradingBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const scope = await staffGrading(app, req, reply, params.data.id);
    if (!scope) return reply;
    try {
      const row = await service.manualOverride(
        app.db,
        {
          attemptId: scope.grading.attemptId,
          itemId: scope.grading.itemId,
          answerId: scope.grading.answerId,
          maxPoints: scope.grading.maxPoints,
        },
        {
          points: body.data.points,
          comment: body.data.comment,
          ...(body.data.details === undefined ? {} : { details: body.data.details }),
        },
        req.user!.id,
        now,
      );
      await afterCorrection(req, scope.evaluation, row, "grading.override");
      return service.toGrading(row);
    } catch (error) {
      return failure(app, reply, error);
    }
  });

  /** F-GRADE-04: validating one proposal, possibly adjusting it on the way. */
  app.post("/app/api/gradings/:id/validate", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const params = GradingIdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = ValidateGradingBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const scope = await staffGrading(app, req, reply, params.data.id);
    if (!scope) return reply;
    try {
      const row = await service.validateGrading(
        app.db,
        scope.grading,
        body.data,
        req.user!.id,
        now,
      );
      await afterCorrection(req, scope.evaluation, row, "grading.validate");
      return service.toGrading(row);
    } catch (error) {
      return failure(app, reply, error);
    }
  });

  /** F-GRADE-04: the filtered batch ("every high-confidence proposal of q3"). */
  app.post(
    "/app/api/evaluations/:id/grading/validate-batch",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      const body = BatchValidateBody.safeParse(emptyBody(req.body));
      if (!body.success) return invalid(reply, body.error);
      try {
        const validated = await service.batchValidate(
          app.db,
          scope.evaluation.id,
          body.data,
          req.user!.id,
          now,
        );
        if (validated > 0) {
          await markModifiedAfterRelease(app.db, scope.evaluation, now);
          await trace(req, "grading.validate", "evaluation", scope.evaluation.id, {
            ...body.data,
            validated,
          });
          events.gradingChanged(scope.evaluation);
        }
        return { validated };
      } catch (error) {
        return failure(app, reply, error);
      }
    },
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
    async (req, reply) => {
      const now = app.clock.now();
      const params = ItemParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = RegradeBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      const items = await joinedItems(app.db, scope.evaluation.id);
      const item = items.find((i) => i.item.id === params.data.itemId);
      if (!item) return reply.code(404).send({ error: "not_found" });

      let note = body.data.note.trim();
      if (body.data.toVersionNumber !== undefined) {
        const [version] = await app.db
          .select({ id: questionVersions.id })
          .from(questionVersions)
          .where(
            and(
              eq(questionVersions.questionId, item.question.id),
              eq(questionVersions.number, body.data.toVersionNumber),
            ),
          )
          .limit(1);
        if (!version) return reply.code(404).send({ error: "not_found" });
        await app.db
          .update(evaluationItems)
          .set({ questionVersionId: version.id })
          .where(eq(evaluationItems.id, item.item.id));
        note = `${note} (re-graded with version ${body.data.toVersionNumber})`;
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
        toVersionNumber: body.data.toVersionNumber ?? null,
        modifiedAfterRelease: modified,
      });
      events.gradingChanged(scope.evaluation);
      return reply
        .code(202)
        .send({ evaluationId: scope.evaluation.id, itemIds: [item.item.id], queued });
    },
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
