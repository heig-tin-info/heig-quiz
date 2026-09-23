/**
 * HTTP surface of the `pool` module (PLAN-MVP §4.2).
 *
 * Every body, query and parameter is parsed by a schema from
 * `@quiz/contracts` (invariant 7); every entity is loaded through a guard
 * that answers 404 when the caller has no access, never 403 (invariant 6);
 * every write is audited and publishes a `pool:<id>` refresh hint.
 *
 * Routes live under `/app/api` (supervisor override of decision D18): the
 * SPA keeps its session cookies, and the future `/api/v1` bearer surface
 * will alias these same handlers.
 */
import { randomUUID } from "node:crypto";

import fastifyMultipart from "@fastify/multipart";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  CategoryCreate,
  CategoryOrder,
  CategoryPatch,
  CopyBody,
  DeprecateBody,
  DraftPut,
  IdParam,
  MoveBody,
  PoolCreate,
  PoolCandidateQuery,
  PoolListQuery,
  PoolMemberInvite,
  PoolMemberParam,
  PoolMemberPatch,
  PoolPatch,
  type PoolRole,
  PreviewBody,
  PublishBody,
  QuestionCreate,
  QuestionPatch,
  QuestionSearch,
  TagParam,
  TagPatch,
  TryBody,
  VersionParam,
  type Asset,
  type MoveBlockingCourse,
  type MoveConflict,
  type MoveResult,
  issuesOf,
  DEFAULT_MCQ_POLICY,
  McqPolicy,
  type QuestionTypeId,
  type TryResult,
} from "@quiz/contracts";
import {
  QUESTION_TYPE_IDS,
  RunnerBusy,
  RunnerUnavailable,
  QuizCoreError,
  type FinalizeContext,
  type GradeContext,
} from "@quiz/core/server";
import { DEFAULT_MCQ_SCORE_POLICY, MCQ_SCORE_POLICIES, type McqScorePolicy } from "@quiz/domain/mcqScore";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { assets, categories, pools, questions } from "../../db/schema.js";
import {
  accessWhere,
  accessibleCategory,
  accessiblePool,
  accessibleQuestion,
  poolAccess,
  poolRoleOf,
  requirePoolRole,
  teacherGuard,
} from "../guards.js";
import { isAllowedMime, pathForHash, readAsset, sha256Of, sniffImage, writeAsset } from "./assets.js";
import { invalid, teacherRoute } from "../http.js";
import { studentViewOf } from "../live/studentView.js";
import { loadConfig, tryLoadConfig, typeOf } from "./config.js";
import { publish } from "../../events.js";
import { notify } from "../notifications/service.js";
import { userTopic } from "../realtime/bus.js";
import { poolChanged, poolPeopleChanged } from "./events.js";
import * as service from "./service.js";

/**
 * The contracts enum and the registry constant must name the same types.
 * This assignment is the compile-time proof: adding a fifth type to
 * `@quiz/core` without adding it to `@quiz/contracts` stops the build here.
 */
const _questionTypesAgree: readonly QuestionTypeId[] = QUESTION_TYPE_IDS;
void _questionTypesAgree;

/**
 * The same proof for the MCQ policies: the wire enum of `@quiz/contracts` and
 * the scoring formulas of `@quiz/domain` (their reference list), both ways,
 * and the same default.
 */
const _mcqPoliciesAgree: readonly McqScorePolicy[] = McqPolicy.options;
const _mcqPoliciesAgreeBack: readonly McqPolicy[] = MCQ_SCORE_POLICIES;
const _mcqDefaultsAgree: typeof DEFAULT_MCQ_SCORE_POLICY = DEFAULT_MCQ_POLICY;
void [_mcqPoliciesAgree, _mcqPoliciesAgreeBack, _mcqDefaultsAgree];

/**
 * A failure raised by the question-type layer is a client error, not a 500:
 * an unregistered type (the registry is filled by WP2/WP3) and a config that
 * cannot be migrated both mean "this question cannot be worked on", with the
 * machine code the UI branches on.
 */
function coreFailure(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof QuizCoreError) {
    return reply.code(422).send({ error: error.code, message: error.message });
  }
  return null;
}

export async function poolPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const trace = tracer(app);
  const mine = (req: FastifyRequest) => accessWhere(req.user!, poolAccess(req.user!.id));

  /**
   * The module's error tail: a refusal of the question-type layer is the
   * `422` of `coreFailure`, anything else is logged and a 500.
   */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    const handled = coreFailure(reply, error);
    if (handled) return handled;
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "pool route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);

  /**
   * The loaders of this module: the entity under `poolAccess` (404 when it
   * is out of reach, invariant 6), then — for a write — the pool role, whose
   * refusal is `requirePoolRole`'s 403 (the caller may see the pool, just not
   * change it). Params, entity, role, then body: the order every route had.
   */
  function withRole<S>(
    load: (req: FastifyRequest, reply: FastifyReply) => Promise<S | null>,
    poolOf: (scope: S) => typeof pools.$inferSelect,
    role: PoolRole | undefined,
  ) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<S | null> => {
      const scope = await load(req, reply);
      if (!scope) return null;
      if (role && !(await requirePoolRole(app, req, reply, poolOf(scope), role))) return null;
      return scope;
    };
  }
  const inPool = (role?: PoolRole) =>
    withRole((req, reply) => accessiblePool(app, req, reply), (pool) => pool, role);
  const onQuestion = (role?: PoolRole) =>
    withRole((req, reply) => accessibleQuestion(app, req, reply), (scope) => scope.pool, role);
  const onCategory = (role?: PoolRole) =>
    withRole((req, reply) => accessibleCategory(app, req, reply), (scope) => scope.pool, role);

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.ASSETS_MAX_BYTES, files: 1, fields: 4 },
  });

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

  // --- Pools -------------------------------------------------------------

  /**
   * Every pool the caller reaches: their own, the ones they were named in,
   * the public ones and the ones their courses draw from — each with the
   * caller's effective role, so the list can say what it offers (F-POOL-05).
   */
  /**
   * The pools list is filtered by `poolAccess` for EVERYONE, admins included:
   * an admin who sees every teacher's private pools on their shelf cannot
   * tell theirs from the others'. `?scope=all` lifts the filter, for an admin
   * only; a teacher asking for it gets their own list.
   */
  app.get("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const query = PoolListQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const everyone = query.data.scope === "all" && req.user!.role === "admin";
    return service.listPools(app.db, everyone ? undefined : poolAccess(req.user!.id), req.user!);
  });

  app.post("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const body = PoolCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const pool = await service.createPool(app.db, { ...body.data, ownerId: req.user!.id });
    await trace(req, "pool.create", "pool", pool.id, {
      name: pool.name,
      visibility: pool.visibility,
    });
    // A brand-new pool has no `pool:<id>` subscriber yet — topics are computed
    // at connection time — so the teacher's own topic is the only one that can
    // carry it. It refreshes `GET /app/api/pools`, which emits nothing back.
    publish("mutation", [`user:${req.user!.id}`]);
    return reply.code(201).send(pool);
  });

  app.get(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, scope: pool }) =>
      service.poolDetail(app.db, pool, await poolRoleOf(app.db, pool, req.user!)),
    ),
  );

  /** Name, icon and visibility are the owner's business (F-POOL-05). */
  app.patch(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolPatch, load: inPool("owner") },
      async ({ req, body, scope: pool }) => {
        const updated = await service.updatePool(app.db, pool.id, body);
        await trace(req, "pool.update", "pool", pool.id, body);
        poolChanged(pool.id);
        // A visibility or a name the members see on their own list too.
        poolPeopleChanged(await topicsOf(pool));
        return updated;
      },
    ),
  );

  app.delete(
    "/app/api/pools/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      // Only an owner disposes of a pool: a course staff member and a named
      // contributor reach it to WORK in it, not to destroy it.
      const audience = await topicsOf(pool);
      if (!(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      await service.deletePool(app.db, pool.id);
      await trace(req, "pool.delete", "pool", pool.id, { name: pool.name });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );

  // --- Members (F-POOL-05) -----------------------------------------------

  /**
   * Who holds a seat on this pool. Readable by anyone the pool lets in: a
   * contributor has to know whom they are working with, and the list carries
   * no more than the colleagues' names.
   */
  app.get(
    "/app/api/pools/:id/members",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, ({ scope: pool }) =>
      service.listMembers(app.db, pool),
    ),
  );

  /**
   * The colleagues an owner may still invite, matched on a few letters of a
   * name or an address: the list behind the picker of the share sheet. Owner
   * only, like the invitation it prepares — a reader of a pool has no
   * business with the directory of the school.
   */
  app.get(
    "/app/api/pools/:id/candidates",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: PoolCandidateQuery, load: inPool("owner") },
      async ({ query, scope: pool }) => {
        return service.listCandidates(app.db, pool, query.q);
      },
    ),
  );

  /**
   * Names a colleague in the pool: an account picked among the candidates,
   * or an address — matched over the whole identity set of an account
   * (GH-11) for a teacher the picker does not list under that spelling. A
   * `private` pool becomes `shared` on the first invitation.
   */
  app.post(
    "/app/api/pools/:id/members",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PoolMemberInvite, load: inPool("owner") },
      async ({ req, reply, body, scope: pool }) => {
        const invitee =
          body.userId !== undefined
            ? await service.findTeacherById(app.db, body.userId)
            : await service.findTeacherByEmail(app.db, body.email!);
        if (!invitee) {
          return reply.code(404).send({
            error: "teacher_not_found",
            message: "No teacher account matches",
          });
        }
        if (await service.isMemberOrOwner(app.db, pool, invitee.id)) {
          return reply
            .code(409)
            .send({ error: "already_member", message: "This account already holds a seat" });
        }
        const added = await service.addMember(app.db, pool, invitee.id, body.role);
        await trace(req, "pool.share", "pool", pool.id, {
          userId: invitee.id,
          email: invitee.email,
          role: body.role,
        });
        await notify(app.db, invitee.id, {
          kind: "pool_shared",
          poolId: pool.id,
          poolName: pool.name,
          role: body.role,
          byName: `${req.user!.givenName ?? ""} ${req.user!.familyName ?? ""}`.trim() || req.user!.email,
        });
        poolChanged(pool.id);
        poolPeopleChanged(await topicsOf(pool));
        return reply.code(201).send(await service.listMembers(app.db, { ...pool, visibility: added.visibility }));
      },
    ),
  );

  /** Changes what a member may do. The `pools.owner_id` account is not here. */
  app.patch(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool("owner") }, async ({ req, reply, scope: pool }) => {
      const params = PoolMemberParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = PoolMemberPatch.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      if (params.data.userId === pool.ownerId) {
        return reply.code(409).send({
          error: "is_owner",
          message: "The owner of the pool holds their seat by ownership",
        });
      }
      const audience = await topicsOf(pool);
      const done = await service.setMemberRole(app.db, pool.id, params.data.userId, body.data.role);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "pool.member_update", "pool", pool.id, {
        userId: params.data.userId,
        role: body.data.role,
      });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return service.listMembers(app.db, pool);
    }),
  );

  /**
   * Removes a seat. An owner removes anyone but the `pools.owner_id` account
   * — that one goes away by a TRANSFER, never by a delete — and a member may
   * remove THEMSELVES, which is how one leaves a pool one was named in.
   */
  app.delete(
    "/app/api/pools/:id/members/:userId",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, reply, scope: pool }) => {
      const params = PoolMemberParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const leaving = params.data.userId === req.user!.id;
      if (!leaving && !(await requirePoolRole(app, req, reply, pool, "owner"))) return reply;
      if (params.data.userId === pool.ownerId) {
        return reply.code(409).send({
          error: "is_owner",
          message: "The owner of a pool cannot be removed from it",
        });
      }
      const audience = await topicsOf(pool);
      const done = await service.removeMember(app.db, pool.id, params.data.userId);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "pool.unshare", "pool", pool.id, {
        userId: params.data.userId,
        left: leaving,
      });
      poolChanged(pool.id);
      poolPeopleChanged(audience);
      return reply.code(204).send();
    }),
  );

  /** The tag vocabulary of the pool: name, description, usage count. */
  app.get(
    "/app/api/pools/:id/tags",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, ({ scope: pool }) =>
      service.poolTags(app.db, pool.id),
    ),
  );

  /**
   * Documents one tag of the pool. The row is created on the spot when the
   * tag only existed on questions so far, so a teacher never has to "declare"
   * a tag before describing it.
   */
  app.patch(
    "/app/api/pools/:id/tags/:tag",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, load: inPool("contributor") },
      async ({ req, reply, scope: pool }) => {
        const params = TagParam.safeParse(req.params);
        if (!params.success) return invalid(reply, params.error);
        const body = TagPatch.safeParse(req.body);
        if (!body.success) return invalid(reply, body.error);
        const tag = await service.describeTag(
          app.db,
          pool.id,
          params.data.tag,
          body.data.description,
        );
        await trace(req, "tag.describe", "pool", pool.id, {
          tag: tag.tag,
          description: tag.description,
        });
        poolChanged(pool.id);
        return tag;
      },
    ),
  );

  // --- Categories --------------------------------------------------------

  app.post(
    "/app/api/pools/:id/categories",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryCreate, load: inPool("contributor") },
      async ({ req, reply, body, scope: pool }) => {
        if (body.parentId) {
          const [parent] = await app.db
            .select({ id: categories.id })
            .from(categories)
            .where(and(eq(categories.id, body.parentId), eq(categories.poolId, pool.id)))
            .limit(1);
          if (!parent) return reply.code(404).send({ error: "not_found" });
        }
        const category = await service.createCategory(app.db, pool.id, body);
        await trace(req, "category.create", "category", category.id, {
          poolId: pool.id,
          name: category.name,
        });
        poolChanged(pool.id);
        return reply.code(201).send(category);
      },
    ),
  );

  app.patch(
    "/app/api/categories/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryPatch, load: onCategory("contributor") },
      async ({ req, reply, body, scope }) => {
        if (body.parentId !== undefined && body.parentId !== null) {
          const [parent] = await app.db
            .select({ poolId: categories.poolId })
            .from(categories)
            .where(eq(categories.id, body.parentId))
            .limit(1);
          if (!parent || parent.poolId !== scope.pool.id) {
            return reply.code(404).send({ error: "not_found" });
          }
          if (await service.wouldCycle(app.db, scope.category.id, body.parentId)) {
            return reply
              .code(409)
              .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
          }
        }
        const updated = await service.updateCategory(app.db, scope.category.id, body);
        await trace(req, "category.update", "category", scope.category.id, body);
        poolChanged(scope.pool.id);
        return updated;
      },
    ),
  );

  app.put(
    "/app/api/pools/:id/categories/order",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CategoryOrder, load: inPool("contributor") },
      async ({ req, reply, body, scope: pool }) => {
        for (const item of body.items) {
          if (item.parentId && (await service.wouldCycle(app.db, item.id, item.parentId))) {
            return reply
              .code(409)
              .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
          }
        }
        const tree = await service.reorderCategories(app.db, pool.id, body.items);
        await trace(req, "category.reorder", "pool", pool.id, { count: body.items.length });
        poolChanged(pool.id);
        return tree;
      },
    ),
  );

  app.delete(
    "/app/api/categories/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onCategory("contributor") }, async ({ req, reply, scope }) => {
      await service.deleteCategory(app.db, scope.category.id);
      await trace(req, "category.delete", "category", scope.category.id, {
        poolId: scope.pool.id,
        name: scope.category.name,
      });
      poolChanged(scope.pool.id);
      return reply.code(204).send();
    }),
  );

  // --- Questions ---------------------------------------------------------

  app.get(
    "/app/api/pools/:id/questions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: QuestionSearch, load: inPool() },
      async ({ reply, query, scope: pool }) => {
        try {
          return await service.listQuestions(app.db, pool.id, query);
        } catch (error) {
          // A cursor is only valid for the order that produced it: a client that
          // changes column mid-scroll starts the list again rather than reading a
          // page that mixes two orders.
          if (error instanceof service.InvalidCursor) {
            return reply
              .code(400)
              .send({ error: "invalid_cursor", message: "Restart the list", reason: error.reason });
          }
          throw error;
        }
      },
    ),
  );

  app.post(
    "/app/api/pools/:id/questions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: QuestionCreate, load: inPool("contributor") },
      async ({ req, reply, body, scope: pool }) => {
        try {
          const id = await service.createQuestion(app.db, {
            poolId: pool.id,
            type: body.type,
            internalName: body.internalName,
            categoryId: body.categoryId ?? null,
            createdBy: req.user!.id,
          });
          const [created] = await app.db.select().from(questions).where(eq(questions.id, id));
          await trace(req, "question.create", "question", id, {
            poolId: pool.id,
            type: body.type,
            internalName: body.internalName,
          });
          poolChanged(pool.id);
          return reply.code(201).send(await service.questionDetail(app.db, created!));
        } catch (error) {
          const handled = coreFailure(reply, error);
          if (handled) return handled;
          return reply
            .code(409)
            .send({ error: "duplicate_name", message: "This pool already has a question by that name" });
        }
      },
    ),
  );

  app.get(
    "/app/api/questions/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion() }, ({ scope }) =>
      service.questionDetail(app.db, scope.question),
    ),
  );

  app.patch(
    "/app/api/questions/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: QuestionPatch, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        try {
          await service.patchQuestion(app.db, scope.question, body);
        } catch {
          return reply
            .code(409)
            .send({ error: "duplicate_name", message: "This pool already has a question by that name" });
        }
        await trace(req, "question.update", "question", scope.question.id, body);
        poolChanged(scope.pool.id);
        const [fresh] = await app.db
          .select()
          .from(questions)
          .where(eq(questions.id, scope.question.id));
        return (await service.questionDetail(app.db, fresh!)).meta;
      },
    ),
  );

  /**
   * Autosave. An invalid config is STORED and comes back with its issues
   * (decision D16): a teacher must be able to leave a question half-written.
   * Deliberately NOT audited — it fires every few seconds per open editor,
   * and the publication that follows carries the content.
   */
  app.put(
    "/app/api/questions/:id/draft",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: DraftPut, load: onQuestion("contributor") },
      async ({ body, scope }) => {
        const saved = await service.putDraft(app.db, scope.question, {
          config: body.config,
          ...(body.explanation !== undefined ? { explanation: body.explanation } : {}),
        });
        poolChanged(scope.pool.id);
        return saved;
      },
    ),
  );

  app.post(
    "/app/api/questions/:id/publish",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PublishBody, optionalBody: true, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        try {
          const version = await service.publishQuestion(app.db, scope.question, {
            userId: req.user!.id,
            ...(body.changeNote !== undefined ? { changeNote: body.changeNote } : {}),
          });
          await trace(req, "question.publish", "question", scope.question.id, {
            number: version.number,
            changeNote: version.changeNote,
          });
          poolChanged(scope.pool.id);
          return reply.code(201).send(version);
        } catch (error) {
          if (error instanceof service.DraftInvalid) {
            return reply
              .code(422)
              .send({ error: "config_invalid", message: "Fix the draft before publishing", details: error.issues });
          }
          if (error instanceof service.MissingDraft) {
            return reply.code(409).send({ error: "no_draft" });
          }
          return coreFailure(reply, error) ?? reply.code(409).send({ error: "publish_conflict" });
        }
      },
    ),
  );

  app.get(
    "/app/api/questions/:id/versions",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion() }, ({ scope }) =>
      service.listVersions(app.db, scope.question.id),
    ),
  );

  app.get(
    "/app/api/questions/:id/versions/:number",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion() }, async ({ req, reply, scope }) => {
      const params = VersionParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const version = await service.versionDetail(app.db, scope.question, params.data.number);
      if (!version) return reply.code(404).send({ error: "not_found" });
      return version;
    }),
  );

  app.post(
    "/app/api/questions/:id/versions/:number/restore",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion("contributor") }, async ({ req, reply, scope }) => {
      const params = VersionParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const done = await service.restoreVersion(app.db, scope.question, params.data.number);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "question.restore_version", "question", scope.question.id, {
        number: params.data.number,
      });
      poolChanged(scope.pool.id);
      const [fresh] = await app.db
        .select()
        .from(questions)
        .where(eq(questions.id, scope.question.id));
      return service.questionDetail(app.db, fresh!);
    }),
  );

  app.post(
    "/app/api/questions/:id/versions/:number/deprecate",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion("contributor") }, async ({ req, reply, scope }) => {
      const params = VersionParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = DeprecateBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const version = await service.deprecateVersion(
        app.db,
        scope.question.id,
        params.data.number,
        body.data.note,
      );
      if (!version) return reply.code(404).send({ error: "not_found" });
      await trace(req, "question.deprecate", "question", scope.question.id, {
        number: params.data.number,
        note: body.data.note,
      });
      poolChanged(scope.pool.id);
      return version;
    }),
  );

  const DeleteQuery = z.object({
    hard: z
      .union([z.string(), z.boolean()])
      .transform((v) => v === true || v === "1" || v === "true")
      .optional(),
  });

  /**
   * Soft delete (F-QST-11). A question whose published version an evaluation
   * points at cannot leave the pool at all — `409 in_use`; `?hard=1` purges
   * the rows instead of hiding them.
   */
  app.delete(
    "/app/api/questions/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: DeleteQuery, load: onQuestion("contributor") },
      async ({ req, reply, query, scope }) => {
        try {
          if (query.hard) await service.hardDeleteQuestion(app.db, scope.question);
          else await service.softDeleteQuestion(app.db, scope.question);
        } catch (error) {
          if (error instanceof service.VersionInUse) {
            return reply.code(409).send({
              error: "in_use",
              message: "An evaluation still uses a published version of this question",
            });
          }
          throw error;
        }
        await trace(req, "question.delete", "question", scope.question.id, {
          hard: query.hard === true,
          internalName: scope.question.internalName,
        });
        poolChanged(scope.pool.id);
        return reply.code(204).send();
      },
    ),
  );

  app.post(
    "/app/api/questions/:id/copy",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: CopyBody, load: onQuestion() },
      async ({ req, reply, body, scope }) => {
        // The target pool must be reachable too, or a copy would be a way to
        // write into someone else's pool.
        const target = await reachablePool(req, body.targetPoolId);
        if (!target) return reply.code(404).send({ error: "not_found" });
        // Reading the source is enough to copy FROM it; writing the copy needs a
        // contributor's seat on the TARGET.
        if (!(await requirePoolRole(app, req, reply, target, "contributor"))) return reply;
        const id = await service.copyQuestion(app.db, scope.question, {
          targetPoolId: target.id,
          categoryId: body.categoryId ?? null,
          userId: req.user!.id,
        });
        await trace(req, "question.copy", "question", id, {
          from: scope.question.id,
          targetPoolId: target.id,
        });
        poolChanged(target.id);
        const [created] = await app.db.select().from(questions).where(eq(questions.id, id));
        return reply.code(201).send(await service.questionDetail(app.db, created!));
      },
    ),
  );


  /**
   * `POST /questions/move` — the question changes pool and KEEPS its id.
   *
   * It is the sibling of `/copy` above and its opposite: a copy is a new
   * question that remembers where it came from, a move is the same question
   * somewhere else. Everything frozen on one of its versions goes on
   * resolving, which is precisely why the id may not change (F-EVAL-03).
   *
   * One route for one question and for twenty: the drag-and-drop of the
   * sidebar sends a list of one. Rights are the ones the two halves of a move
   * really are — `contributor` on every SOURCE pool (what it takes to delete
   * a question from it) and `contributor` on the TARGET (what it takes to
   * create one there) — and a target the caller cannot reach is a 404, like
   * any entity they cannot see (invariant 6).
   *
   * The refusal that matters is the third one: a classroom already PLAYS one
   * of these questions, and the target pool is not among the pools its course
   * draws from. Moving would leave the staff of that course unable to reach
   * the question again. The server always checks it; the client only asks the
   * teacher and retries with `linkCourses: true`, which links the pool to
   * those courses — never to a course the caller is not staff of (ADR-017).
   */
  app.post("/app/api/questions/move", { preHandler: requireTeacher }, async (req, reply) => {
    const body = MoveBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const ids = [...new Set(body.data.questionIds)];

    const sources = await moveSources(req, ids);
    if (sources.length !== ids.length) return reply.code(404).send({ error: "not_found" });
    const target = await reachablePool(req, body.data.targetPoolId);
    if (!target) return reply.code(404).send({ error: "not_found" });

    const sourcePools = new Map(sources.map((row) => [row.pool.id, row.pool]));
    for (const pool of [...sourcePools.values(), target]) {
      if (!(await requirePoolRole(app, req, reply, pool, "contributor"))) return reply;
    }

    const categoryId = body.data.categoryId ?? null;
    if (!(await isCategoryOf(target.id, categoryId))) {
      return reply.code(404).send({ error: "not_found" });
    }

    const named = await blockingCourses(req, ids, target.id);
    const refusal = linkRefusal(named, body.data.linkCourses, target);
    if (refusal) return reply.code(409).send(refusal);
    const linkCourseIds = named.map((c) => c.courseId);

    try {
      await service.moveQuestions(app.db, {
        questions: sources.map((row) => row.question),
        targetPoolId: target.id,
        categoryId,
        linkCourseIds,
      });
    } catch (error) {
      if (error instanceof service.MoveNameTaken) {
        const conflict: MoveConflict = {
          error: "name_taken",
          message: `The pool "${target.name}" already has a question named ${error.names[0]}`,
          courses: [],
          names: error.names,
        };
        return reply.code(409).send(conflict);
      }
      throw error;
    }

    await afterMove(req, sources, target, categoryId, linkCourseIds);
    const result: MoveResult = {
      moved: sources.length,
      questionIds: sources.map((row) => row.question.id),
      targetPoolId: target.id,
      categoryId,
      linkedCourseIds: linkCourseIds,
    };
    return result;
  });

  /**
   * Every source question of a move, LOADED under `poolAccess` in one query:
   * a list that comes back short holds at least one question this caller
   * cannot see, and the answer is the same 404 a missing id would give.
   */
  function moveSources(req: FastifyRequest, ids: string[]) {
    return app.db
      .select({ question: questions, pool: pools })
      .from(questions)
      .innerJoin(pools, eq(questions.poolId, pools.id))
      .where(and(inArray(questions.id, ids), mine(req)));
  }

  /** A pool named in a body, loaded under `poolAccess`; null when out of reach. */
  async function reachablePool(req: FastifyRequest, poolId: string) {
    const [pool] = await app.db
      .select()
      .from(pools)
      .where(and(eq(pools.id, poolId), mine(req)))
      .limit(1);
    return pool ?? null;
  }

  /**
   * A category is a category OF THE TARGET; one belonging to another pool is
   * as good as missing. No category at all is fine.
   */
  async function isCategoryOf(poolId: string, categoryId: string | null): Promise<boolean> {
    if (categoryId === null) return true;
    const [category] = await app.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.poolId, poolId)))
      .limit(1);
    return category !== undefined;
  }

  /**
   * The courses that already PLAY one of these questions and do not draw
   * from the target pool, each with whether the caller may link the pool to
   * it (a staff seat there, or admin).
   */
  async function blockingCourses(
    req: FastifyRequest,
    ids: string[],
    targetPoolId: string,
  ): Promise<MoveBlockingCourse[]> {
    const using = await service.coursesUsingQuestions(app.db, ids);
    const linked = await service.coursesLinkedToPool(
      app.db,
      targetPoolId,
      using.map((c) => c.courseId),
    );
    const blocking = using.filter((c) => !linked.has(c.courseId));
    const seats =
      req.user!.role === "admin"
        ? null
        : await service.staffSeatsOf(app.db, req.user!.id, blocking.map((c) => c.courseId));
    return blocking.map((c) => ({
      ...c,
      mayLink: seats === null || seats.has(c.courseId),
    }));
  }

  /**
   * The 409 a move meets while blocking courses remain: the client has not
   * asked to link them yet, or one of them is a course the caller may not
   * link. Null when the move may go on (linking every blocking course).
   */
  function linkRefusal(
    named: MoveBlockingCourse[],
    linkCourses: boolean | undefined,
    target: typeof pools.$inferSelect,
  ): MoveConflict | null {
    if (named.length === 0) return null;
    if (linkCourses !== true) {
      return {
        error: "pool_not_linked",
        message: `This question is used by ${named[0]!.courseCode}; the pool "${target.name}" is not one of that course's pools`,
        courses: named,
        names: [],
      };
    }
    const forbidden = named.filter((c) => !c.mayLink);
    if (forbidden.length > 0) {
      return {
        error: "course_forbidden",
        message: `You are not on the teaching staff of ${forbidden[0]!.courseCode}, so this pool cannot be added to it`,
        courses: forbidden,
        names: [],
      };
    }
    return null;
  }

  /** The audit rows and the refresh hints of a move that went through. */
  async function afterMove(
    req: FastifyRequest,
    sources: Awaited<ReturnType<typeof moveSources>>,
    target: typeof pools.$inferSelect,
    categoryId: string | null,
    linkCourseIds: string[],
  ): Promise<void> {
    for (const row of sources) {
      await trace(req, "question.move", "question", row.question.id, {
        fromPoolId: row.pool.id,
        toPoolId: target.id,
        categoryId,
        internalName: row.question.internalName,
      });
    }
    for (const courseId of linkCourseIds) {
      await trace(req, "course.pools_update", "course", courseId, {
        addedPoolId: target.id,
        reason: "question.move",
      });
      publish("courses", [`course:${courseId}`, `teacher:${req.user!.id}`]);
    }
    // Both ends refresh: the questions left one list and joined another.
    const poolIds = new Set([...sources.map((row) => row.pool.id), target.id]);
    for (const poolId of poolIds) poolChanged(poolId);
  }

  // --- Preview and try ---------------------------------------------------

  /** The config of `"draft"` or of a published number, migrated and parsed. */
  async function configOf(
    reply: FastifyReply,
    question: typeof questions.$inferSelect,
    source: "draft" | number,
  ): Promise<{ config: unknown } | null> {
    const row =
      source === "draft"
        ? await service.draftOf(app.db, question.id)
        : await service.versionRow(app.db, question.id, source);
    if (!row) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const outcome = tryLoadConfig(question.type, row);
    if (!outcome.ok) {
      await reply
        .code(422)
        .send({ error: "config_invalid", message: "This version cannot be rendered", details: outcome.issues });
      return null;
    }
    return { config: outcome.config };
  }

  app.post(
    "/app/api/questions/:id/preview",
    // A read behind a POST: no refresh hint on its response (see `app.ts`).
    { preHandler: requireTeacher, config: { readOnly: true } },
    teacher(
      { params: IdParam, body: PreviewBody, optionalBody: true, load: onQuestion() },
      async ({ reply, body, scope }) => {
        const loaded = await configOf(reply, scope.question, body.source);
        if (!loaded) return reply;
        const t = typeOf(scope.question.type);
        return {
          // The type, so a client that has nothing but this payload knows which
          // `Player` to mount (the full-page preview of one question).
          type: scope.question.type,
          // Teacher preview: seed 0 and no shuffle, so the view is stable
          // between two reloads (decision D19). It goes through the ONE student
          // exit of the API (`live/studentView.ts`), like every other payload a
          // student could ever see (invariant 4, WP5).
          student: studentViewOf(scope.question.type, loaded.config, {
            seed: 0,
            itemId: scope.question.id,
            shuffle: false,
          }),
          itemPoints: t.defaultPoints(loaded.config),
        };
      },
    ),
  );

  /**
   * Teacher rehearsal (F-QST-09): the answer is graded in process and
   * nothing is persisted. A `pending: runner` grading is forwarded to the
   * runner when there is one, and degrades to `runner_unavailable`
   * otherwise (decision D14) — never to a 500.
   */
  app.post(
    "/app/api/questions/:id/try",
    // A read behind a POST: no refresh hint on its response (see `app.ts`).
    { preHandler: requireTeacher, config: { readOnly: true } },
    teacher(
      { params: IdParam, body: TryBody, optionalBody: true, load: onQuestion() },
      async ({ reply, body, scope }) => {
        try {
          const loaded = await configOf(reply, scope.question, body.source);
          if (!loaded) return reply;
          const t = typeOf(scope.question.type);
          const answer =
            body.answer === undefined || body.answer === null
              ? null
              : t.answerSchema.parse(body.answer);
          const view = { seed: 0, itemId: scope.question.id, shuffle: false };
          const base: FinalizeContext = {
            seed: 0,
            itemId: scope.question.id,
            attemptId: randomUUID(),
            itemPoints: t.defaultPoints(loaded.config),
            now: new Date(),
          };
          // `app.runner` is always decorated (`modules/runner/index.ts`); on a
          // machine without a container engine it is the `UnavailableRunner`,
          // whose `run()` rejects with `RunnerUnavailable` (decision D14).
          const runner = app.runner;
          const ctx: GradeContext = { ...base, runner };
          const result = await t.grade(loaded.config, answer, ctx);

          if (result.kind === "graded") {
            return graded(result.points, result.maxPoints, result.details, t.toSolution(loaded.config, view));
          }
          if (result.via === "llm") return { status: "llm_unavailable" } satisfies TryResult;
          if (!t.finalizeRunner) {
            return { status: "runner_unavailable", reason: "not_configured" } satisfies TryResult;
          }
          const outcome = await runner.run(result.request);
          const final = t.finalizeRunner(loaded.config, answer, base, outcome);
          return graded(final.points, final.maxPoints, final.details, t.toSolution(loaded.config, view));
        } catch (error) {
          if (error instanceof RunnerUnavailable) {
            return { status: "runner_unavailable", reason: error.reason } satisfies TryResult;
          }
          if (error instanceof RunnerBusy) {
            return { status: "runner_unavailable", reason: "busy" } satisfies TryResult;
          }
          if (error instanceof z.ZodError) {
            return reply.code(422).send({ error: "answer_invalid", details: issuesOf(error) });
          }
          // The rest is the module's tail: `coreFailure`, else a 500.
          throw error;
        }
      },
    ),
  );

  // --- Assets ------------------------------------------------------------

  app.post(
    "/app/api/pools/:id/assets",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, load: inPool("contributor") },
      async ({ req, reply, scope: pool }) => {
        const upload = await readImage(req, reply);
        if (!upload) return reply;
        const { row, fresh } = await storeAsset(req, pool.id, upload);
        if (!fresh) return reply.code(200).send(assetJson(row));
        await trace(req, "pool.asset_upload", "asset", row.id, {
          poolId: pool.id,
          mime: row.mime,
          bytes: row.bytes,
        });
        return reply.code(201).send(assetJson(row));
      },
    ),
  );

  /**
   * The one image of a multipart upload, or null once the refusal is sent:
   * `415` when it is not multipart, `400` without a file, and `415` again
   * when the BYTES are not an accepted image — the bytes decide the type, not
   * the header, so an SVG (or anything else) sniffs to nothing and is refused
   * here. Past `ASSETS_MAX_BYTES` the `413` is Fastify's: `toBuffer()` throws
   * `FST_REQ_FILE_TOO_LARGE`, which the wrapper hands to the global handler.
   */
  async function readImage(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ bytes: Buffer; facts: NonNullable<ReturnType<typeof sniffImage>> } | null> {
    if (!req.isMultipart()) {
      await reply.code(415).send({ error: "unsupported_media_type", message: "Expected multipart/form-data" });
      return null;
    }
    const part = await req.file();
    if (!part) {
      await reply.code(400).send({ error: "validation", message: "No file in the request" });
      return null;
    }
    const bytes = await part.toBuffer();
    const facts = sniffImage(bytes);
    if (!facts || !isAllowedMime(facts.mime)) {
      await reply.code(415).send({
        error: "unsupported_media_type",
        message: "Only PNG, JPEG, GIF and WebP images are accepted",
      });
      return null;
    }
    return { bytes, facts };
  }

  /**
   * Content-addressed storage: the same bytes as an earlier upload are one
   * row and one file, whoever uploaded them first, and nothing is written a
   * second time (`fresh: false`). A concurrent upload of the same bytes that
   * wins the insert is read back the same way.
   */
  async function storeAsset(
    req: FastifyRequest,
    poolId: string,
    upload: { bytes: Buffer; facts: NonNullable<ReturnType<typeof sniffImage>> },
  ): Promise<{ row: typeof assets.$inferSelect; fresh: boolean }> {
    const { bytes, facts } = upload;
    const sha256 = sha256Of(bytes);
    const path = pathForHash(sha256);
    const [existing] = await app.db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
    if (existing) return { row: existing, fresh: false };
    await writeAsset(config.ASSETS_DIR, path, bytes);
    const [created] = await app.db
      .insert(assets)
      .values({
        id: randomUUID(),
        ownerId: req.user!.id,
        poolId,
        sha256,
        mime: facts.mime,
        bytes: bytes.length,
        width: facts.width,
        height: facts.height,
        path,
      })
      .onConflictDoNothing({ target: assets.sha256 })
      .returning();
    if (created) return { row: created, fresh: true };
    const [raced] = await app.db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
    return { row: raced!, fresh: false };
  }

  /**
   * Served from our own origin, with an immutable cache (the URL contains a
   * uuid whose bytes never change) and `nosniff`: the browser gets exactly
   * the type we verified at upload, and nothing else.
   */
  app.get(
    "/app/api/assets/:id",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [asset] = await app.db.select().from(assets).where(eq(assets.id, params.data.id)).limit(1);
      if (!asset || !isAllowedMime(asset.mime)) return reply.code(404).send({ error: "not_found" });
      // Assets are content-addressed and deduplicated across the whole
      // instance (`unique (sha256)`), so `assets.pool_id` names the pool that
      // uploaded the bytes FIRST, not the set of pools that show them: a
      // per-pool check would break the second teacher's image. Any staff
      // session may therefore read an asset — its id is a random uuid, and a
      // colleague holding the same bytes obtains the same id anyway.
      // A STUDENT reaches it through the attempt that shows it, and only
      // then (`assetReachableBy`): the image of a question they are taking
      // or reviewing, never the instance's image store.
      const staff = req.user!.role === "teacher" || req.user!.role === "admin";
      const allowed =
        staff ||
        asset.ownerId === req.user!.id ||
        (await service.assetReachableBy(app.db, asset.id, req.user!.id));
      if (!allowed) return reply.code(404).send({ error: "not_found" });
      let bytes: Buffer;
      try {
        bytes = await readAsset(config.ASSETS_DIR, asset.path);
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply
        .header("content-type", asset.mime)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", "inline")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(bytes);
    },
  );
}

function assetJson(row: typeof assets.$inferSelect): Asset {
  return {
    id: row.id,
    url: `/app/api/assets/${row.id}`,
    mime: row.mime as Asset["mime"],
    bytes: row.bytes,
    width: row.width,
    height: row.height,
  };
}

function graded(
  points: number,
  maxPoints: number,
  details: unknown,
  solution: unknown,
): TryResult {
  return { status: "graded", points, maxPoints, details, solution };
}

