/**
 * What every route file of the `pool` module shares: the guards, the audit
 * tracer, the wrapper with the module's failure arms, and the loaders.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PoolRole } from "@quiz/contracts";
import { QuizCoreError } from "@quiz/core/server";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { pools } from "../../db/schema.js";
import {
  accessWhere,
  accessibleCategory,
  accessiblePool,
  accessibleQuestion,
  poolAccess,
  requirePoolRole,
  teacherGuard,
} from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import { userTopic } from "../realtime/bus.js";
import * as service from "./service.js";

/**
 * A failure raised by the question-type layer is a client error, not a 500:
 * an unregistered type (the registry is filled by WP2/WP3) and a config that
 * cannot be migrated both mean "this question cannot be worked on", with the
 * machine code the UI branches on.
 */
export function coreFailure(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof QuizCoreError) {
    return reply.code(422).send({ error: error.code, message: error.message });
  }
  return null;
}

/**
 * The module's own arms: `coreFailure`, and a category outside the pool as
 * the bare 404 a missing entity gets (the one `POST /questions/move` sends).
 */
function poolFailure(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof service.CategoryNotInPool) return notFound(reply);
  return coreFailure(reply, error);
}

export function poolRouteContext(app: FastifyInstance, config: AppConfig) {
  const requireTeacher = teacherGuard(app);
  const trace = tracer(app);
  const mine = (req: FastifyRequest) => accessWhere(req.user!, poolAccess(req.user!.id));

  const teacher = teacherRoute(app, poolFailure);

  /**
   * The loaders of this module: the entity under `poolAccess` (404 when it
   * is out of reach, invariant 6), then — for a write — the pool role, whose
   * refusal is `requirePoolRole`'s 403 (the caller may see the pool, just not
   * change it). Params, entity, role, then body: the order every route had.
   */
  function withRole<S>(
    load: (req: FastifyRequest, reply: FastifyReply, params: { id: string }) => Promise<S | null>,
    poolOf: (scope: S) => typeof pools.$inferSelect,
    role: PoolRole | undefined,
  ) {
    return async (
      req: FastifyRequest,
      reply: FastifyReply,
      params: { id: string },
    ): Promise<S | null> => {
      const scope = await load(req, reply, params);
      if (!scope) return null;
      if (role && !(await requirePoolRole(app, req, reply, poolOf(scope), role))) return null;
      return scope;
    };
  }
  const inPool = (role?: PoolRole) =>
    withRole((req, reply, p) => accessiblePool(app, req, reply, p), (pool) => pool, role);
  const onQuestion = (role?: PoolRole) =>
    withRole((req, reply, p) => accessibleQuestion(app, req, reply, p), (scope) => scope.pool, role);
  const onCategory = (role?: PoolRole) =>
    withRole((req, reply, p) => accessibleCategory(app, req, reply, p), (scope) => scope.pool, role);

  /**
   * The people a change of the pool's roster must reach, on their OWN topic.
   *
   * `pool:<id>` is computed when a connection OPENS, so the colleague who has
   * just been named — or the one who has just been removed — is exactly the
   * one it does not carry. `user:<id>` always reaches them, and a hint carries
   * no data, so nobody learns anything they could not already read.
   */
  const topicsOf = async (pool: typeof pools.$inferSelect) =>
    (await service.poolAudience(app.db, pool)).map(userTopic);

  return { config, requireTeacher, trace, mine, teacher, inPool, onQuestion, onCategory, topicsOf };
}

export type PoolRouteContext = ReturnType<typeof poolRouteContext>;
