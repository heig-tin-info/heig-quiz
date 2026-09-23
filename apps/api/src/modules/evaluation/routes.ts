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
import { and, eq } from "drizzle-orm";
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

import { tracer } from "../../audit.js";
import { classrooms, courses } from "../../db/schema.js";
import { loadConfig, typeOf } from "../pool/config.js";
import {
  accessibleClassroom,
  accessibleEvaluation,
  loadEvaluation,
  staffAccess,
  teacherGuard,
} from "../guards.js";
import { emptyBody, invalid } from "../http.js";
import * as live from "../live/service.js";
import { evaluationChanged } from "./events.js";
import * as service from "./service.js";

/** Everything this module refuses carries its own status and machine code. */
function evaluationFailure(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof service.EvaluationError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  return null;
}

export async function evaluationPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** The audit entry every write of this module leaves behind. */
  const trace = tracer(app);

  const detail = (
    req: FastifyRequest,
    row: service.EvaluationRecord,
  ): Promise<EvaluationDetail> => service.evaluationDetail(app.db, row, req.user!.id);

  // --- Collection --------------------------------------------------------

  app.get(
    "/app/api/classrooms/:id/evaluations",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleClassroom(app, req, reply);
      if (!scope) return reply;
      return service.listEvaluations(app.db, scope.room.id);
    },
  );

  app.post(
    "/app/api/classrooms/:id/evaluations",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleClassroom(app, req, reply);
      if (!scope) return reply;
      const body = EvaluationCreate.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        const row = await service.createEvaluation(app.db, {
          classroomId: scope.room.id,
          title: body.data.title,
          mode: body.data.mode,
          preset: body.data.preset,
          createdBy: req.user!.id,
        });
        await trace(req, "evaluation.create", "evaluation", row.id, {
          title: row.title,
          mode: row.mode,
        });
        evaluationChanged(scope.room.id, row.id);
        return reply.code(201).send(service.toEvaluation(row));
      } catch (error) {
        return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  // --- One evaluation ----------------------------------------------------

  app.get("/app/api/evaluations/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    return detail(req, scope.evaluation);
  });

  app.patch("/app/api/evaluations/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = EvaluationPatch.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
      const row = await service.patchEvaluation(app.db, scope.evaluation, body.data, {
        attemptCount,
      });
      await trace(req, "evaluation.update", "evaluation", row.id, {
        fields: Object.keys(body.data),
      });
      evaluationChanged(row.classroomId, row.id);
      return detail(req, row);
    } catch (error) {
      return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  app.delete("/app/api/evaluations/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = EvaluationDelete.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    // Naming the evaluation is the confirmation: a destructive action is
    // never one click away from a live grid.
    if (body.data.confirmTitle !== scope.evaluation.title) {
      return reply.code(409).send({ error: "confirm_mismatch" });
    }
    await service.deleteEvaluation(app.db, scope.evaluation);
    await trace(req, "evaluation.delete", "evaluation", scope.evaluation.id, {
      title: scope.evaluation.title,
    });
    evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
    return reply.code(204).send();
  });

  app.post(
    "/app/api/evaluations/:id/duplicate",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      const body = EvaluationDuplicate.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      // A copy into another classroom is a write there: it goes through the
      // same predicate, so a teacher cannot seed a room they cannot reach.
      let target = scope.classroom.id;
      if (body.data.classroomId !== undefined && body.data.classroomId !== target) {
        const [other] = await app.db
          .select({ id: classrooms.id })
          .from(classrooms)
          .innerJoin(courses, eq(classrooms.courseId, courses.id))
          .where(
            and(
              eq(classrooms.id, body.data.classroomId),
              req.user!.role === "admin" ? undefined : staffAccess(req.user!.id),
            ),
          )
          .limit(1);
        if (!other) return reply.code(404).send({ error: "not_found" });
        target = other.id;
      }
      const row = await service.duplicateEvaluation(app.db, scope.evaluation, {
        classroomId: target,
        title: body.data.title,
        createdBy: req.user!.id,
      });
      await trace(req, "evaluation.duplicate", "evaluation", row.id, { from: scope.evaluation.id });
      evaluationChanged(target, row.id);
      return reply.code(201).send(service.toEvaluation(row));
    },
  );

  // --- Items -------------------------------------------------------------

  app.post("/app/api/evaluations/:id/items", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = ItemsAdd.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
      const items = await service.addItems(
        app.db,
        scope.evaluation,
        body.data.questionIds,
        // F-EVAL-02: the type decides the default weight, from the config it
        // owns — this module never looks inside a config.
        (type, version) =>
          typeOf(type).defaultPoints(
            loadConfig(type, { config: version.config, configVersion: version.configVersion }),
          ),
        { attemptCount },
      );
      await trace(req, "evaluation.items_update", "evaluation", scope.evaluation.id, {
        added: body.data.questionIds.length,
      });
      evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
      return items;
    } catch (error) {
      return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  app.patch(
    "/app/api/evaluations/:id/items/:itemId",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const params = ItemParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      const body = ItemPatch.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
        const items = await service.patchItem(
          app.db,
          scope.evaluation,
          params.data.itemId,
          body.data,
          { attemptCount },
        );
        await trace(req, "evaluation.items_update", "evaluation", scope.evaluation.id, {
          itemId: params.data.itemId,
        });
        evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
        return items;
      } catch (error) {
        return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  app.put(
    "/app/api/evaluations/:id/items/order",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      const body = ItemsOrder.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
        const items = await service.reorderItems(app.db, scope.evaluation, body.data.itemIds, {
          attemptCount,
        });
        await trace(req, "evaluation.items_update", "evaluation", scope.evaluation.id, {
          reordered: true,
        });
        evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
        return items;
      } catch (error) {
        return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  app.delete(
    "/app/api/evaluations/:id/items/:itemId",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const params = ItemParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      try {
        const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
        await service.deleteItem(app.db, scope.evaluation, params.data.itemId, { attemptCount });
        await trace(req, "evaluation.items_update", "evaluation", scope.evaluation.id, {
          removed: params.data.itemId,
        });
        evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
        return reply.code(204).send();
      } catch (error) {
        return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  /** F-EVAL-03: the one-click "use the latest version", while it is still legal. */
  app.post(
    "/app/api/evaluations/:id/items/update-versions",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      const body = UpdateVersions.safeParse(emptyBody(req.body));
      if (!body.success) return invalid(reply, body.error);
      try {
        const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);
        const items = await service.updateVersions(
          app.db,
          scope.evaluation,
          body.data.itemIds,
          { attemptCount },
        );
        await trace(req, "evaluation.items_versions", "evaluation", scope.evaluation.id, {
          itemIds: body.data.itemIds ?? "all",
        });
        evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);
        return items;
      } catch (error) {
        return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  // --- State and preview -------------------------------------------------

  app.post("/app/api/evaluations/:id/state", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = EvaluationStateBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const row = await service.transition(
        app.db,
        scope.evaluation,
        body.data.to,
        app.clock.now(),
      );
      await trace(req, "evaluation.state", "evaluation", row.id, {
        from: scope.evaluation.state,
        to: row.state,
      });
      evaluationChanged(row.classroomId, row.id);
      return service.toEvaluation(row);
    } catch (error) {
      return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  /**
   * "See it as a student" (§4.3): a REAL student view built by
   * `studentView()`, with seed 0 and no attempt row anywhere. The teacher
   * cannot answer it, so nothing can be persisted by accident.
   */
  app.post(
    "/app/api/evaluations/:id/preview",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      return live.previewView(app.db, scope.evaluation, app.clock.now());
    },
  );
}
