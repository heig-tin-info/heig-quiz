/**
 * Reports on a question (issue #680, lot 3). Reporting needs only what
 * reading the question needs (`poolAccess`, 404 otherwise, invariant 6): a
 * reader, a subscriber, course staff or a public reader — never a student,
 * since every route here is a teacher route. Resolving needs `contributor`
 * (or Super Powers, which is `owner` for `poolRoleOf`).
 */
import type { FastifyInstance } from "fastify";

import { IdParam, ReportCreate, ReportParam, ReportResolve } from "@quiz/contracts";

import { type PoolRouteContext } from "./routeContext.js";
import * as service from "./service.js";

export function reportRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, poolWrite, teacher, onQuestion, seesAllReports } = ctx;

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
      const { question, pool } = scope;
      const write = () => service.createReport(app.db, { question, pool, reporterId: req.user!.id, message: body.message });
      const report = await poolWrite(req, pool.id, write, (row) => [
        "question.report", "question", question.id, { reportId: row.id, poolId: pool.id },
      ]);
      return reply.code(201).send(report);
    }),
  );

  app.post(
    "/app/api/questions/:id/reports/:reportId/resolve",
    { preHandler: requireTeacher },
    teacher(
      { params: ReportParam, body: ReportResolve, load: onQuestion("contributor") },
      async ({ req, body, scope, params }) => {
        const { question, pool } = scope;
        const resolution = { reportId: params.reportId, resolverId: req.user!.id, reply: body.reply, now: app.clock.now() };
        await poolWrite(req, pool.id, () => service.resolveReport(app.db, { question, pool, ...resolution }), (report) => [
          "question.report_resolve", "question", question.id,
          { reportId: report.id, poolId: pool.id, replied: report.resolution !== "" },
        ]);
        return { ok: true };
      },
    ),
  );
}
