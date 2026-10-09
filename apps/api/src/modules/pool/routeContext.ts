/**
 * What every route file of the `pool` module shares: the guards, the audit
 * tracer, the wrapper with the module's failure arms, and the loaders.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PoolRole } from "@quiz/contracts";
import { QuizCoreError } from "@quiz/core/server";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { pools, questions } from "../../db/schema.js";
import {
  accessibleCategory,
  accessiblePool,
  accessibleQuestion,
  accessWhere,
  callerOf,
  poolAccess,
  requirePoolRole,
  teacherGuard,
  withRoleStep,
} from "../guards.js";
import { notFound, teacherRoute } from "../http.js";
import { LlmError, llmFailure } from "../llm/service.js";
import { userTopic } from "../realtime/bus.js";
import { GenerateRefusal } from "./generate.js";
import { ReviewRefusal } from "./review.js";
import * as service from "./service.js";

/** A held-down wand, not a quota (ADR-059): the gateway's daily cap is the ceiling. */
export const LLM_CALLS_PER_MINUTE = 10;


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
 * The module's own arms: `coreFailure`; a category outside the pool as the
 * bare 404 a missing entity gets (the one `POST /questions/move` sends); a
 * wand or a review refused before any model (`fix_stale`, a fix that no
 * longer applies, is a 409); and a model call that failed, as `llmFailure`
 * words it for every screen.
 */
function poolFailure(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof service.CategoryNotInPool) return notFound(reply);
  if (error instanceof GenerateRefusal || error instanceof ReviewRefusal) {
    return reply.code(error.code === "fix_stale" ? 409 : 400).send({ error: error.code });
  }
  if (error instanceof LlmError) {
    const { status, body } = llmFailure(error);
    return reply.code(status).send(body);
  }
  return coreFailure(reply, error);
}

export function poolRouteContext(app: FastifyInstance, config: AppConfig) {
  const requireTeacher = teacherGuard(app);
  const trace = tracer(app);
  const mine = (req: FastifyRequest) => accessWhere(callerOf(req), poolAccess(req.user!.id));

  const teacher = teacherRoute(app, poolFailure);

  /**
   * The questions of a batch, each with its pool, LOADED under `poolAccess`
   * in one query (invariant 6). A list that comes back shorter than `ids`
   * holds a question this caller cannot see, and the routes answer the whole
   * batch with the 404 a missing id gives. `ids` must be deduplicated.
   */
  const questionsInReach = (req: FastifyRequest, ids: string[]) =>
    app.db
      .select({ question: questions, pool: pools })
      .from(questions)
      .innerJoin(pools, eq(questions.poolId, pools.id))
      .where(and(inArray(questions.id, ids), mine(req)));

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
    return withRoleStep(load, role && ((req, reply, scope) => requirePoolRole(app, req, reply, poolOf(scope), role)));
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

  return {
    config,
    requireTeacher,
    trace,
    mine,
    teacher,
    inPool,
    onQuestion,
    onCategory,
    topicsOf,
    questionsInReach,
  };
}

export type PoolRouteContext = ReturnType<typeof poolRouteContext>;
