/**
 * HTTP surface of the `evaluation` module (PLAN-MVP §4.3).
 *
 * Authoring only. The operational transitions (start, pause, resume, close,
 * extend) are `live` routes, because what they really move is the attempts;
 * `POST /state` here covers `draft`, `scheduled` and `lobby`.
 *
 * Every body is parsed by a schema from `@quiz/contracts` (invariant 7),
 * every entity is loaded by a guard that answers 404 (invariant 6), and every
 * write is audited (invariant 9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  EvaluationCreate,
  EvaluationDelete,
  EvaluationDuplicate,
  EvaluationPatch,
  EvaluationStateBody,
  IdParam,
  ItemParam,
  ItemPatch,
  ItemsAdd,
  ItemsOrder,
  UpdateVersions,
  type EvaluationDetail,
} from "@quiz/contracts";

import { tracer, type AuditAction } from "../../audit.js";
import { hasKey, loadConfig, typeOf } from "../pool/config.js";
import { findAccessibleClassroom, loadEvaluation, teacherGuard } from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import * as live from "../live/service.js";
import { evaluationChanged } from "./events.js";
import * as service from "./service.js";

export async function evaluationPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** Everything this module refuses carries its own status and machine code; the rest is a 500. */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof service.EvaluationError) {
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message, ...error.details });
    }
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "evaluation route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);

  /** The audit entry every write of this module leaves behind. */
  const trace = tracer(app);

  const detail = (
    req: FastifyRequest,
    row: service.EvaluationRecord,
  ): Promise<EvaluationDetail> => service.evaluationDetail(app.db, row, req.user!.id);

  // The loaders of invariant 6, each answering its own 404.
  const staffClassroom = async (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => {
    const scope = await findAccessibleClassroom(app.db, req.user!, p.id);
    if (scope) return scope;
    await notFound(reply);
    return null;
  };
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);

  /**
   * One write of the evaluation's content (B-09): what is legal depends on
   * whether an attempt exists, so the count is read first and handed to the
   * service; then the audit entry and the SSE refresh, in that order.
   */
  async function contentWrite<T>(
    req: FastifyRequest,
    evaluation: service.EvaluationRecord,
    action: AuditAction,
    payload: unknown,
    write: (ctx: { attemptCount: number }) => Promise<T>,
  ): Promise<T> {
    const attemptCount = await service.attemptCount(app.db, evaluation.id);
    const result = await write({ attemptCount });
    await trace(req, action, "evaluation", evaluation.id, payload);
    evaluationChanged(evaluation.classroomId, evaluation.id);
    return result;
  }

  // --- Collection --------------------------------------------------------

  app.get(
    "/app/api/classrooms/:id/evaluations",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ scope }) =>
      service.listEvaluations(app.db, scope.room.id),
    ),
  );

  app.post(
    "/app/api/classrooms/:id/evaluations",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: EvaluationCreate, load: staffClassroom },
      async ({ req, reply, body, scope }) => {
        const row = await service.createEvaluation(app.db, {
          classroomId: scope.room.id,
          title: body.title,
          mode: body.mode,
          preset: body.preset,
          createdBy: req.user!.id,
        });
        await trace(req, "evaluation.create", "evaluation", row.id, {
          title: row.title,
          mode: row.mode,
        });
        evaluationChanged(scope.room.id, row.id);
        return reply.code(201).send(service.toEvaluation(row));
      },
    ),
  );

  // --- One evaluation ----------------------------------------------------

  app.get(
    "/app/api/evaluations/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ req, scope }) =>
      detail(req, scope.evaluation),
    ),
  );

  /** The pools the question picker offers: the course's own (F-EVAL-01). */
  app.get(
    "/app/api/evaluations/:id/pools",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ req, scope }) =>
      service.listCoursePools(app.db, scope.evaluation.id, req.user!),
    ),
  );

  app.patch(
    "/app/api/evaluations/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: EvaluationPatch, load: staffEvaluation },
      async ({ req, body, scope }) => {
        const row = await contentWrite(
          req,
          scope.evaluation,
          "evaluation.update",
          { fields: Object.keys(body) },
          (ctx) => service.patchEvaluation(app.db, scope.evaluation, body, ctx),
        );
        return detail(req, row);
      },
    ),
  );

  app.delete(
    "/app/api/evaluations/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: EvaluationDelete, optionalBody: true, load: staffEvaluation },
      async ({ req, reply, body, scope }) => {
        // Naming the evaluation is the confirmation: a destructive action is
        // never one click away from a live grid.
        if (body.confirmTitle !== scope.evaluation.title) {
          return reply.code(409).send({ error: "confirm_mismatch" });
        }
        await service.deleteEvaluation(app.db, scope.evaluation);
        await trace(req, "evaluation.delete", "evaluation", scope.evaluation.id, {
          title: scope.evaluation.title,
        });
        evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
        return reply.code(204).send();
      },
    ),
  );

  app.post(
    "/app/api/evaluations/:id/duplicate",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: EvaluationDuplicate, load: staffEvaluation },
      async ({ req, reply, body, scope }) => {
        // A copy into another classroom is a write there: it goes through the
        // same predicate, so a teacher cannot seed a room they cannot reach.
        let target = scope.classroom.id;
        if (body.classroomId !== undefined && body.classroomId !== target) {
          const other = await findAccessibleClassroom(app.db, req.user!, body.classroomId);
          if (!other) return notFound(reply);
          target = other.room.id;
        }
        const row = await service.duplicateEvaluation(app.db, scope.evaluation, {
          classroomId: target,
          title: body.title,
          createdBy: req.user!.id,
        });
        await trace(req, "evaluation.duplicate", "evaluation", row.id, { from: scope.evaluation.id });
        evaluationChanged(target, row.id);
        return reply.code(201).send(service.toEvaluation(row));
      },
    ),
  );

  // --- Items -------------------------------------------------------------

  app.post(
    "/app/api/evaluations/:id/items",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ItemsAdd, load: staffEvaluation },
      ({ req, body, scope }) =>
        contentWrite(
          req,
          scope.evaluation,
          "evaluation.items_update",
          { added: body.questionIds.length },
          (ctx) =>
            service.addItems(
              app.db,
              scope.evaluation,
              body.questionIds,
              // F-EVAL-02: the type decides the default weight, from the config it
              // owns — this module never looks inside a config.
              (type, version) =>
                typeOf(type).defaultPoints(
                  loadConfig(type, { config: version.config, configVersion: version.configVersion }),
                ),
              ctx,
              // A question kept after an opinion poll has no key: polls only.
              (type, version) =>
                hasKey(
                  type,
                  loadConfig(type, { config: version.config, configVersion: version.configVersion }),
                ),
            ),
        ),
    ),
  );

  app.patch(
    "/app/api/evaluations/:id/items/:itemId",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: ItemPatch, load: staffEvaluation },
      ({ req, params, body, scope }) =>
        contentWrite(
          req,
          scope.evaluation,
          "evaluation.items_update",
          { itemId: params.itemId },
          (ctx) => service.patchItem(app.db, scope.evaluation, params.itemId, body, ctx),
        ),
    ),
  );

  app.put(
    "/app/api/evaluations/:id/items/order",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ItemsOrder, load: staffEvaluation },
      ({ req, body, scope }) =>
        contentWrite(req, scope.evaluation, "evaluation.items_update", { reordered: true }, (ctx) =>
          service.reorderItems(app.db, scope.evaluation, body.itemIds, ctx),
        ),
    ),
  );

  app.delete(
    "/app/api/evaluations/:id/items/:itemId",
    { preHandler: requireTeacher },
    teacher({ params: ItemParam, load: staffEvaluation }, async ({ req, reply, params, scope }) => {
      await contentWrite(
        req,
        scope.evaluation,
        "evaluation.items_update",
        { removed: params.itemId },
        (ctx) => service.deleteItem(app.db, scope.evaluation, params.itemId, ctx),
      );
      return reply.code(204).send();
    }),
  );

  /** F-EVAL-03: the one-click "use the latest version", while it is still legal. */
  app.post(
    "/app/api/evaluations/:id/items/update-versions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: UpdateVersions, optionalBody: true, load: staffEvaluation },
      ({ req, body, scope }) =>
        contentWrite(
          req,
          scope.evaluation,
          "evaluation.items_versions",
          { itemIds: body.itemIds ?? "all" },
          (ctx) => service.updateVersions(app.db, scope.evaluation, body.itemIds, ctx),
        ),
    ),
  );

  // --- State and preview -------------------------------------------------

  app.post(
    "/app/api/evaluations/:id/state",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: EvaluationStateBody, load: staffEvaluation },
      async ({ req, now, body, scope }) => {
        const row = await service.transition(app.db, scope.evaluation, body.to, now);
        await trace(req, "evaluation.state", "evaluation", row.id, {
          from: scope.evaluation.state,
          to: row.state,
        });
        evaluationChanged(row.classroomId, row.id);
        return service.toEvaluation(row);
      },
    ),
  );

  /**
   * "See it as a student" (§4.3): a REAL student view built by
   * `studentView()`, with seed 0 and no attempt row anywhere. The teacher
   * cannot answer it, so nothing can be persisted by accident.
   */
  app.post(
    "/app/api/evaluations/:id/preview",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ now, scope }) =>
      live.previewView(app.db, scope.evaluation, now),
    ),
  );
}
