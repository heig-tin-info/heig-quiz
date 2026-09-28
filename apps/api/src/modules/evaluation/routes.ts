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
  TemplateCreate,
  TemplateInstantiate,
  TemplateNew,
  TemplatePatch,
  UpdateVersions,
  type EvaluationDetail,
  type TemplateDetail,
  type TemplateInstance,
} from "@quiz/contracts";

import { tracer, type AuditAction } from "../../audit.js";
import { hasKey, loadConfig, typeOf } from "../pool/config.js";
import {
  accessibleCourse,
  findAccessibleClassroom,
  loadEvaluation,
  loadTemplate,
  teacherGuard,
} from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import * as live from "../live/service.js";
import { evaluationChanged } from "./events.js";
import * as service from "./service.js";
import * as templates from "./templates.js";

export async function evaluationPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** Everything this module refuses carries its own status and machine code; the rest is a 500. */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    // Exactly the loader's 404 (invariant 6), not an error envelope with a message.
    if (error instanceof templates.TemplateGone) return notFound(reply);
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

  const detail = async (
    req: FastifyRequest,
    row: service.EvaluationRecord,
  ): Promise<EvaluationDetail> =>
    // The lobby ring's denominator, a rule of the `live` module (#152).
    service.evaluationDetail(app.db, row, req.user!, await live.enrolledCount(app.db, row));

  // F-EVAL-02: the type decides an item's default weight, from the config it
  // owns — this module never looks inside a config. And a question kept after
  // an opinion poll has no key: polls only. Shared by evaluations and templates.
  const versionConfig = (type: string, version: service.JoinedItem["version"]) =>
    loadConfig(type, { config: version.config, configVersion: version.configVersion });
  const defaultPoints = (type: string, version: service.JoinedItem["version"]) =>
    typeOf(type).defaultPoints(versionConfig(type, version));
  const keyed = (type: string, version: service.JoinedItem["version"]) =>
    hasKey(type, versionConfig(type, version));

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
    evaluationChanged(service.classroomIdOf(evaluation), evaluation.id);
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
      service.listCoursePools(app.db, { classroomId: scope.classroom.id }, req.user!),
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
        evaluationChanged(service.classroomIdOf(scope.evaluation), scope.evaluation.id);
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
        const row = await service.copyEvaluation(app.db, scope.evaluation, {
          home: { classroomId: target },
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
            service.addItems(app.db, scope.evaluation, body.questionIds, defaultPoints, ctx, keyed),
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

  // --- State ---------------------------------------------------------------

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
        evaluationChanged(service.classroomIdOf(row), row.id);
        return service.toEvaluation(row);
      },
    ),
  );

  // --- Templates (ADR-031) --------------------------------------------------
  //
  // A template is reached through its COURSE's staff (`loadTemplate`), never
  // through `loadEvaluation`, whose classroom join cannot find one: none of
  // the generic routes above ever sees a template.

  const staffTemplate = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadTemplate(app, req, reply, p.id);

  app.get(
    "/app/api/courses/:id/templates",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: (req, reply) => accessibleCourse(app, req, reply) }, ({ scope }) =>
      templates.listTemplates(app.db, scope.id),
    ),
  );

  /** "Save as template": the evaluation, into its course, without anything of a run. */
  app.post(
    "/app/api/evaluations/:id/template",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: TemplateCreate, load: staffEvaluation },
      async ({ req, reply, body, scope }) => {
        const row = await templates.saveAsTemplate(app.db, scope.evaluation, {
          courseId: scope.classroom.courseId,
          title: body.title,
          createdBy: req.user!.id,
        });
        await trace(req, "template.create", "evaluation", row.id, {
          from: scope.evaluation.id,
          courseId: scope.classroom.courseId,
          title: row.title,
        });
        return reply.code(201).send(await templates.templateOf(app.db, row));
      },
    ),
  );

  /** F-EVAL-24: a new, empty template of the course, at revision 1. */
  app.post(
    "/app/api/courses/:id/templates",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: TemplateNew, load: (req, reply) => accessibleCourse(app, req, reply) },
      async ({ req, reply, body, scope }) => {
        const row = await templates.createTemplate(app.db, {
          courseId: scope.id,
          title: body.title,
          mode: body.mode,
          preset: body.preset,
          createdBy: req.user!.id,
        });
        // No `from`: an empty template copies nothing (ADR-031, addendum b).
        await trace(req, "template.create", "evaluation", row.id, {
          courseId: scope.id,
          title: row.title,
          mode: row.mode,
        });
        return reply.code(201).send(await templates.templateOf(app.db, row));
      },
    ),
  );

  // --- Editing a template in place (F-EVAL-25) ------------------------------
  //
  // Parallel to the evaluation routes above, loaded by `loadTemplate` only
  // (ADR-031, addendum c), and sharing their SERVICE functions: every write
  // goes through `templates.editTemplate`, which runs it under the template's
  // row lock and moves the revision once when the content moved. A template
  // has no classroom, hence no SSE topic: nothing is published.

  const templateDetail = (req: FastifyRequest, row: service.EvaluationRecord): Promise<TemplateDetail> =>
    templates.templateDetail(app.db, row, req.user!);

  /** One audited write to a template; `change` says what the request did. */
  async function templateWrite(
    req: FastifyRequest,
    template: service.EvaluationRecord,
    change: Record<string, unknown>,
    write: Parameters<typeof templates.editTemplate>[2],
  ): Promise<TemplateDetail> {
    const { row, revised } = await templates.editTemplate(app.db, template, write);
    await trace(req, "template.update", "evaluation", row.id, {
      ...change,
      revised,
      revision: row.revision,
    });
    return templateDetail(req, row);
  }

  app.get(
    "/app/api/templates/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffTemplate }, ({ req, scope }) =>
      templateDetail(req, scope.template),
    ),
  );

  /** The pools the question picker offers: the course's own (F-EVAL-01). */
  app.get(
    "/app/api/templates/:id/pools",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffTemplate }, ({ req, scope }) =>
      service.listCoursePools(app.db, { courseId: scope.course.id }, req.user!),
    ),
  );

  app.patch(
    "/app/api/templates/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: TemplatePatch, load: staffTemplate },
      ({ req, body, scope }) =>
        templateWrite(req, scope.template, { fields: Object.keys(body) }, (tx, row, ctx) =>
          service.patchEvaluation(tx, row, body, ctx),
        ),
    ),
  );

  app.post(
    "/app/api/templates/:id/items",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ItemsAdd, load: staffTemplate },
      ({ req, body, scope }) =>
        templateWrite(req, scope.template, { added: body.questionIds.length }, (tx, row, ctx) =>
          service.addItems(tx, row, body.questionIds, defaultPoints, ctx, keyed),
        ),
    ),
  );

  app.patch(
    "/app/api/templates/:id/items/:itemId",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: ItemPatch, load: staffTemplate },
      ({ req, params, body, scope }) =>
        templateWrite(req, scope.template, { itemId: params.itemId, fields: Object.keys(body) }, (tx, row, ctx) =>
          service.patchItem(tx, row, params.itemId, body, ctx),
        ),
    ),
  );

  app.put(
    "/app/api/templates/:id/items/order",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ItemsOrder, load: staffTemplate },
      ({ req, body, scope }) =>
        templateWrite(req, scope.template, { reordered: true }, (tx, row, ctx) =>
          service.reorderItems(tx, row, body.itemIds, ctx),
        ),
    ),
  );

  /** Unlike an evaluation's (204), answers the detail: the revision may have moved. */
  app.delete(
    "/app/api/templates/:id/items/:itemId",
    { preHandler: requireTeacher },
    teacher({ params: ItemParam, load: staffTemplate }, ({ req, params, scope }) =>
      templateWrite(req, scope.template, { removed: params.itemId }, (tx, row, ctx) =>
        service.deleteItem(tx, row, params.itemId, ctx),
      ),
    ),
  );

  /** F-EVAL-03's "use the latest version", on a template: one revision for the lot. */
  app.post(
    "/app/api/templates/:id/items/update-versions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: UpdateVersions, optionalBody: true, load: staffTemplate },
      ({ req, body, scope }) =>
        templateWrite(req, scope.template, { versions: body.itemIds ?? "all" }, (tx, row, ctx) =>
          service.updateVersions(tx, row, body.itemIds, ctx),
        ),
    ),
  );

  /** Its instances keep running and lose their link to it. */
  app.delete(
    "/app/api/templates/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffTemplate }, async ({ req, reply, scope }) => {
      await templates.deleteTemplate(app.db, scope.template);
      await trace(req, "template.delete", "evaluation", scope.template.id, {
        courseId: scope.course.id,
        title: scope.template.title,
      });
      return reply.code(204).send();
    }),
  );

  /**
   * "Instantiate" into a classroom of the SAME course. A classroom of another
   * course — even one the caller is staff of — is the 404 of a classroom this
   * template does not reach.
   */
  app.post(
    "/app/api/templates/:id/instances",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: TemplateInstantiate, load: staffTemplate },
      async ({ req, reply, body, scope }) => {
        const room = await findAccessibleClassroom(app.db, req.user!, body.classroomId);
        if (!room || room.room.courseId !== scope.course.id) return notFound(reply);
        const made = await templates.instantiateTemplate(app.db, scope.template, {
          classroomId: room.room.id,
          title: body.title ?? scope.template.title,
          createdBy: req.user!.id,
        });
        await trace(req, "template.instantiate", "evaluation", made.evaluation.id, {
          templateId: scope.template.id,
          // The revision copied, read under the template's lock (ADR-031, addendum e).
          revision: made.evaluation.originRevision,
          classroomId: room.room.id,
        });
        evaluationChanged(room.room.id, made.evaluation.id);
        const answer: TemplateInstance = {
          evaluation: service.toEvaluation(made.evaluation),
          deprecatedItems: made.deprecatedItems,
        };
        return reply.code(201).send(answer);
      },
    ),
  );

  // "See it as a student" moved to `modules/preview` (issue #75): the same
  // `POST /evaluations/:id/preview`, now with a fresh seed and a grading.
}
