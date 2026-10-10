/**
 * HTTP surface of the `grading` module (PLAN-MVP §4.5).
 *
 * Teacher only, from the first line to the last: nothing here is reachable
 * with a student session, and an evaluation another teacher owns answers 404,
 * never 403 (invariant 6); a write on a released evaluation is the course
 * owner's, a 403 (ADR-068 §3, amended 2026-10-10). Every body is parsed by a schema from
 * `@quiz/contracts` (invariant 7) and every write is audited (invariant 9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AnswerIdParam,
  BatchValidateBody,
  GradingIdParam,
  GradingQuery,
  GradingRunBody,
  IdParam,
  ItemParam,
  type ItemVersions,
  type GradingRunAccepted,
  ManualGradingBody,
  RegradeBody,
  ValidateGradingBody,
} from "@quiz/contracts";
import { evaluationGradingRole } from "@quiz/domain";

import { tracer, type AuditAction } from "../../audit.js";
import { loadEvaluation, staffAnswer, staffGrading, teacherGuard, withCourseRole } from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import { joinedItem, joinedItems } from "../evaluation/service.js";
import { listVersions } from "../pool/service.js";
import { markModifiedAfterRelease } from "../results/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";

export async function gradingPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** Params, scope, then body: access is loaded before anything else is checked (invariant 6). */
  const teacher = teacherRoute(app);

  const trace = tracer(app);

  // The loaders of invariant 6, each answering its own 404.
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const answerOf = (req: FastifyRequest, reply: FastifyReply, p: { answerId: string }) =>
    staffAnswer(app, req, reply, p.answerId);
  const gradingOf = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    staffGrading(app, req, reply, p.id);

  /**
   * The same loaders for a WRITE, with the role step of ADR-068 §3 (amended
   * 2026-10-10): once the evaluation is released, a correction changes a
   * published grade, which is the owner's as the release is
   * (`evaluationGradingRole`) — `403 owner_required` for an assistant,
   * before the body. Before the release every member grades.
   */
  const gradingRole = (scope: { evaluation: { releasedAt: Date | null } }) =>
    evaluationGradingRole({ released: scope.evaluation.releasedAt !== null });
  const gradedEvaluation = withCourseRole(app, staffEvaluation, (s) => s.classroom.courseId, gradingRole);
  const gradedAnswer = withCourseRole(app, answerOf, (s) => s.courseId, gradingRole);
  const gradedGrading = withCourseRole(app, gradingOf, (s) => s.courseId, gradingRole);

  // --- The automatic pass ------------------------------------------------

  /**
   * `POST /evaluations/:id/grading/run`. The pass skips every cell that
   * already has a validated grading, so pressing the button twice costs a
   * second pass and changes nothing that a teacher settled (#273: never
   * deduplicated, see `enqueueEvaluationGrading`).
   */
  app.post(
    "/app/api/evaluations/:id/grading/run",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: GradingRunBody, optionalBody: true, load: gradedEvaluation },
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

  /** The questions and the state of each, for the question selector (#107). */
  app.get(
    "/app/api/evaluations/:id/grading/steps",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.gradingSteps(app.db, scope.evaluation),
    ),
  );

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
    await service.assertPointsInRange(app.db, evaluation, cell, body.points);
    const row = await service.manualOverride(
      app.db,
      cell,
      { points: body.points, comment: body.comment },
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
          const scope = await gradedAnswer(req, reply, p);
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
      { params: GradingIdParam, body: ManualGradingBody, load: gradedGrading },
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
      { params: GradingIdParam, body: ValidateGradingBody, optionalBody: true, load: gradedGrading },
      async ({ req, now, body, scope }) => {
        if (body.points !== undefined) {
          await service.assertPointsInRange(app.db, scope.evaluation, scope.grading, body.points);
        }
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
      { params: IdParam, body: BatchValidateBody, optionalBody: true, load: gradedEvaluation },
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
   * The published versions a regrade may target (issue #106), newest first,
   * with the number the evaluation froze. Scoped by the evaluation item and
   * loaded through the staff guard, NOT through `poolAccess`: the pool route
   * `GET /questions/:id/versions` refuses a co-teacher once the question's
   * pool is unlinked from the course (or the question moved to a private
   * pool), and whoever may grade the evaluation must still see what they
   * grade against.
   */
  app.get(
    "/app/api/evaluations/:id/items/:itemId/versions",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, load: staffEvaluation },
      async ({ reply, params, scope }): Promise<ItemVersions | FastifyReply> => {
        const item = await joinedItem(app.db, scope.evaluation.id, params.itemId);
        if (!item) return notFound(reply);
        return {
          frozenNumber: item.version.number!,
          versions: await listVersions(app.db, item.question.id),
        };
      },
    ),
  );

  /**
   * Re-grades ONE item across every attempt. Optionally repoints the item at
   * a newer published version first; every grading the pass writes carries
   * `regrade_note`, and the ones it replaces become `superseded`.
   */
  app.post(
    "/app/api/evaluations/:id/items/:itemId/regrade",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: RegradeBody, load: gradedEvaluation },
      async ({ req, reply, now, params, body, scope }) => {
        const item = await joinedItem(app.db, scope.evaluation.id, params.itemId);
        if (!item) return notFound(reply);

        const note = await service.regradeItem(
          app.db,
          {
            evaluationId: scope.evaluation.id,
            itemId: item.item.id,
            questionId: item.question.id,
            variables: item.version.variables,
          },
          body,
        );
        if (note === null) return notFound(reply);
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
