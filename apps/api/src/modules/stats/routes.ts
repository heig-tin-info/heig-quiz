/**
 * HTTP surface of the `stats` module (ADR-038): the item analysis a pool
 * screen shows beside its questions. Reads only, for anyone who can read the
 * pool (ADR-013); the reset is a write to the question and lives in the
 * `pool` module.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdParam } from "@quiz/contracts";

import { accessiblePool, accessibleQuestion, teacherGuard } from "../guards.js";
import { teacherRoute } from "../http.js";
import * as service from "./service.js";

export async function statsPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const teacher = teacherRoute(app);

  // The loaders of invariant 6: out of reach answers the 404 of a missing entity.
  const pool = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessiblePool(app, req, reply, p);
  const question = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleQuestion(app, req, reply, p);

  /** F-STAT-02: the questions of the pool that have enough answers, in one call. */
  app.get(
    "/app/api/pools/:id/question-stats",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: pool }, ({ scope }) =>
      service.poolQuestionStats(app.db, scope.id),
    ),
  );

  /** F-STAT-01: one question, and where its statistics start. */
  app.get(
    "/app/api/questions/:id/stats",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: question }, ({ scope }) =>
      service.questionStats(app.db, scope.question),
    ),
  );
}
