/**
 * Reports on a question (issue #680, lot 3). Reporting needs only what
 * reading the question needs (`poolAccess`, 404 otherwise, invariant 6): a
 * reader, a subscriber, course staff or a public reader — never a student,
 * since every route here is a teacher route. Resolving needs `contributor`
 * (or Super Powers, which is `owner` for `poolRoleOf`).
 */
import type { FastifyInstance } from "fastify";

import { IdParam, ReportCreate, ReportParam, ReportResolve } from "@quiz/contracts";

import { poolChanged } from "./events.js";
import { type PoolRouteContext } from "./routeContext.js";
import * as service from "./service.js";

export function reportRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, onQuestion, seesAllReports } = ctx;

  app.get(
    "/app/api/questions/:id/reports",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion() }, async ({ req, scope }) => {
      const seesAll = await seesAllReports(req, scope.pool);
      return service.listReports(app.db, scope.question.id, { id: req.user!.id, seesAll });
    }),
  );

  app.post(
    "/app/api/questions/:id/reports",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: ReportCreate, load: onQuestion() }, async ({ req, reply, body, scope }) => {
      // A deleted question is the 404 of a missing one (`createReport`).
      const report = await service.createReport(app.db, {
        question: scope.question,
        pool: scope.pool,
        reporterId: req.user!.id,
        message: body.message,
      });
      await trace(req, "question.report", "question", scope.question.id, {
        reportId: report.id,
        poolId: scope.pool.id,
      });
      poolChanged(scope.pool.id);
      return reply.code(201).send(report);
    }),
  );

  app.post(
    "/app/api/questions/:id/reports/:reportId/resolve",
    { preHandler: requireTeacher },
    teacher(
      { params: ReportParam, body: ReportResolve, load: onQuestion("contributor") },
      async ({ req, body, scope, params }) => {
        const report = await service.resolveReport(app.db, {
          question: scope.question,
          pool: scope.pool,
          reportId: params.reportId,
          resolverId: req.user!.id,
          reply: body.reply,
          now: app.clock.now(),
        });
        await trace(req, "question.report_resolve", "question", scope.question.id, {
          reportId: report.id,
          poolId: scope.pool.id,
          replied: report.resolution !== "",
        });
        poolChanged(scope.pool.id);
        return { ok: true };
      },
    ),
  );
}
