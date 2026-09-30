/**
 * HTTP surface of the `stats` module (ADR-038): the item analysis a pool
 * screen shows beside its questions. One read, for anyone who can read the
 * pool (ADR-013); the reset is a write to the question and lives in the
 * `pool` module.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdParam } from "@quiz/contracts";

import { accessiblePool, teacherGuard } from "../guards.js";
import { teacherRoute } from "../http.js";
import * as service from "./service.js";

export async function statsPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const teacher = teacherRoute(app);

  // The loader of invariant 6: out of reach answers the 404 of a missing entity.
  const pool = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessiblePool(app, req, reply, p);

  /** F-STAT-01/02: the questions of the pool that have enough answers, in one call. */
  app.get(
    "/app/api/pools/:id/question-stats",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: pool }, ({ scope }) =>
      service.poolQuestionStats(app.db, scope.id),
    ),
  );
}
