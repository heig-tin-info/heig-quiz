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
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  CategoryCreate,
  CategoryOrder,
  CategoryPatch,
  CopyBody,
  DeprecateBody,
  DraftPut,
  PoolCreate,
  PoolPatch,
  PreviewBody,
  PublishBody,
  QuestionCreate,
  QuestionPatch,
  QuestionSearch,
  TryBody,
  VersionParam,
  type Asset,
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
  type RunnerService,
} from "@quiz/core/server";

import { audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { assets, categories, pools, questions } from "../../db/schema.js";
import {
  accessibleCategory,
  accessiblePool,
  accessibleQuestion,
  poolAccess,
  teacherGuard,
} from "../guards.js";
import { isAllowedMime, pathForHash, readAsset, sha256Of, sniffImage, writeAsset } from "./assets.js";
import { studentViewOf } from "../live/studentView.js";
import { issuesOf, loadConfig, tryLoadConfig, typeOf } from "./config.js";
import { poolChanged } from "./events.js";
import * as service from "./service.js";

/**
 * The contracts enum and the registry constant must name the same types.
 * This assignment is the compile-time proof: adding a fifth type to
 * `@quiz/core` without adding it to `@quiz/contracts` stops the build here.
 */
const _questionTypesAgree: readonly QuestionTypeId[] = QUESTION_TYPE_IDS;
void _questionTypesAgree;

/** The empty-body case: Fastify hands over `undefined` on a bodyless POST. */
const emptyBody = (body: unknown) => (body === undefined || body === null ? {} : body);

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "validation", details: issuesOf(error) });
}

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

/**
 * The runner decoration is added by WP3 (`RUNNER_MODE`); until then — and on
 * any instance that runs without one — `POST /try` answers
 * `runner_unavailable` instead of failing (decision D14). Typed structurally
 * on purpose, so this file does not have to declare the decorator WP3 owns.
 */
function runnerOf(app: FastifyInstance): RunnerService | undefined {
  return (app as unknown as { runner?: RunnerService }).runner;
}

export async function poolPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const mine = (req: FastifyRequest) =>
    req.user!.role === "admin" ? undefined : poolAccess(req.user!.id);

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.ASSETS_MAX_BYTES, files: 1, fields: 4 },
  });

  // --- Pools -------------------------------------------------------------

  app.get("/app/api/pools", { preHandler: requireTeacher }, async (req) =>
    service.listPools(app.db, mine(req)),
  );

  app.post("/app/api/pools", { preHandler: requireTeacher }, async (req, reply) => {
    const body = PoolCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const pool = await service.createPool(app.db, { ...body.data, ownerId: req.user!.id });
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "pool.create",
      subjectType: "pool",
      subjectId: pool.id,
      payload: { name: pool.name, visibility: pool.visibility },
    });
    return reply.code(201).send(pool);
  });

  app.get("/app/api/pools/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    return service.poolDetail(app.db, pool);
  });

  app.patch("/app/api/pools/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    const body = PoolPatch.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const updated = await service.updatePool(app.db, pool.id, body.data);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "pool.update",
      subjectType: "pool",
      subjectId: pool.id,
      payload: body.data,
    });
    poolChanged(pool.id);
    return updated;
  });

  app.delete("/app/api/pools/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    // Only the owner disposes of a pool: a course staff member reaches it
    // through `course_pools` to work in it, not to destroy it.
    if (pool.ownerId !== req.user!.id && req.user!.role !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "Only the owner deletes a pool" });
    }
    await service.deletePool(app.db, pool.id);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "pool.delete",
      subjectType: "pool",
      subjectId: pool.id,
      payload: { name: pool.name },
    });
    poolChanged(pool.id);
    return reply.code(204).send();
  });

  app.get("/app/api/pools/:id/tags", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    return service.poolTags(app.db, pool.id);
  });

  // --- Categories --------------------------------------------------------

  app.post("/app/api/pools/:id/categories", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    const body = CategoryCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    if (body.data.parentId) {
      const [parent] = await app.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, body.data.parentId), eq(categories.poolId, pool.id)))
        .limit(1);
      if (!parent) return reply.code(404).send({ error: "not_found" });
    }
    const category = await service.createCategory(app.db, pool.id, body.data);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "category.create",
      subjectType: "category",
      subjectId: category.id,
      payload: { poolId: pool.id, name: category.name },
    });
    poolChanged(pool.id);
    return reply.code(201).send(category);
  });

  app.patch("/app/api/categories/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleCategory(app, req, reply);
    if (!scope) return reply;
    const body = CategoryPatch.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    if (body.data.parentId !== undefined && body.data.parentId !== null) {
      const [parent] = await app.db
        .select({ poolId: categories.poolId })
        .from(categories)
        .where(eq(categories.id, body.data.parentId))
        .limit(1);
      if (!parent || parent.poolId !== scope.pool.id) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (await service.wouldCycle(app.db, scope.category.id, body.data.parentId)) {
        return reply
          .code(409)
          .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
      }
    }
    const updated = await service.updateCategory(app.db, scope.category.id, body.data);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "category.update",
      subjectType: "category",
      subjectId: scope.category.id,
      payload: body.data,
    });
    poolChanged(scope.pool.id);
    return updated;
  });

  app.put(
    "/app/api/pools/:id/categories/order",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const pool = await accessiblePool(app, req, reply);
      if (!pool) return reply;
      const body = CategoryOrder.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      for (const item of body.data.items) {
        if (item.parentId && (await service.wouldCycle(app.db, item.id, item.parentId))) {
          return reply
            .code(409)
            .send({ error: "cycle", message: "A folder cannot be moved inside itself" });
        }
      }
      const tree = await service.reorderCategories(app.db, pool.id, body.data.items);
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "category.reorder",
        subjectType: "pool",
        subjectId: pool.id,
        payload: { count: body.data.items.length },
      });
      poolChanged(pool.id);
      return tree;
    },
  );

  app.delete("/app/api/categories/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleCategory(app, req, reply);
    if (!scope) return reply;
    await service.deleteCategory(app.db, scope.category.id);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "category.delete",
      subjectType: "category",
      subjectId: scope.category.id,
      payload: { poolId: scope.pool.id, name: scope.category.name },
    });
    poolChanged(scope.pool.id);
    return reply.code(204).send();
  });

  // --- Questions ---------------------------------------------------------

  app.get("/app/api/pools/:id/questions", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    const query = QuestionSearch.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    return service.listQuestions(app.db, pool.id, query.data);
  });

  app.post("/app/api/pools/:id/questions", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    const body = QuestionCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const id = await service.createQuestion(app.db, {
        poolId: pool.id,
        type: body.data.type,
        internalName: body.data.internalName,
        categoryId: body.data.categoryId ?? null,
        createdBy: req.user!.id,
      });
      const [created] = await app.db.select().from(questions).where(eq(questions.id, id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "question.create",
        subjectType: "question",
        subjectId: id,
        payload: { poolId: pool.id, type: body.data.type, internalName: body.data.internalName },
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
  });

  app.get("/app/api/questions/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    try {
      return await service.questionDetail(app.db, scope.question);
    } catch (error) {
      return coreFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  app.patch("/app/api/questions/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = QuestionPatch.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      await service.patchQuestion(app.db, scope.question, body.data);
    } catch {
      return reply
        .code(409)
        .send({ error: "duplicate_name", message: "This pool already has a question by that name" });
    }
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "question.update",
      subjectType: "question",
      subjectId: scope.question.id,
      payload: body.data,
    });
    poolChanged(scope.pool.id);
    const [fresh] = await app.db
      .select()
      .from(questions)
      .where(eq(questions.id, scope.question.id));
    return (await service.questionDetail(app.db, fresh!)).meta;
  });

  /**
   * Autosave. An invalid config is STORED and comes back with its issues
   * (decision D16): a teacher must be able to leave a question half-written.
   * Deliberately NOT audited — it fires every few seconds per open editor,
   * and the publication that follows carries the content.
   */
  app.put("/app/api/questions/:id/draft", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = DraftPut.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const saved = await service.putDraft(app.db, scope.question, {
        config: body.data.config,
        ...(body.data.explanation !== undefined ? { explanation: body.data.explanation } : {}),
      });
      poolChanged(scope.pool.id);
      return saved;
    } catch (error) {
      return coreFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  app.post("/app/api/questions/:id/publish", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = PublishBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    try {
      const version = await service.publishQuestion(app.db, scope.question, {
        userId: req.user!.id,
        ...(body.data.changeNote !== undefined ? { changeNote: body.data.changeNote } : {}),
      });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "question.publish",
        subjectType: "question",
        subjectId: scope.question.id,
        payload: { number: version.number, changeNote: version.changeNote },
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
  });

  app.get("/app/api/questions/:id/versions", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    return service.listVersions(app.db, scope.question.id);
  });

  app.get(
    "/app/api/questions/:id/versions/:number",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleQuestion(app, req, reply);
      if (!scope) return reply;
      const params = VersionParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      try {
        const version = await service.versionDetail(app.db, scope.question, params.data.number);
        if (!version) return reply.code(404).send({ error: "not_found" });
        return version;
      } catch (error) {
        return coreFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
      }
    },
  );

  app.post(
    "/app/api/questions/:id/versions/:number/restore",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleQuestion(app, req, reply);
      if (!scope) return reply;
      const params = VersionParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const done = await service.restoreVersion(app.db, scope.question, params.data.number);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "question.restore_version",
        subjectType: "question",
        subjectId: scope.question.id,
        payload: { number: params.data.number },
      });
      poolChanged(scope.pool.id);
      const [fresh] = await app.db
        .select()
        .from(questions)
        .where(eq(questions.id, scope.question.id));
      return service.questionDetail(app.db, fresh!);
    },
  );

  app.post(
    "/app/api/questions/:id/versions/:number/deprecate",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleQuestion(app, req, reply);
      if (!scope) return reply;
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
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "question.deprecate",
        subjectType: "question",
        subjectId: scope.question.id,
        payload: { number: params.data.number, note: body.data.note },
      });
      poolChanged(scope.pool.id);
      return version;
    },
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
  app.delete("/app/api/questions/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const query = DeleteQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    try {
      if (query.data.hard) await service.hardDeleteQuestion(app.db, scope.question);
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
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "question.delete",
      subjectType: "question",
      subjectId: scope.question.id,
      payload: { hard: query.data.hard === true, internalName: scope.question.internalName },
    });
    poolChanged(scope.pool.id);
    return reply.code(204).send();
  });

  app.post("/app/api/questions/:id/copy", { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = CopyBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    // The target pool must be reachable too, or a copy would be a way to
    // write into someone else's pool.
    const [target] = await app.db
      .select()
      .from(pools)
      .where(and(eq(pools.id, body.data.targetPoolId), mine(req)))
      .limit(1);
    if (!target) return reply.code(404).send({ error: "not_found" });
    const id = await service.copyQuestion(app.db, scope.question, {
      targetPoolId: target.id,
      categoryId: body.data.categoryId ?? null,
      userId: req.user!.id,
    });
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "question.copy",
      subjectType: "question",
      subjectId: id,
      payload: { from: scope.question.id, targetPoolId: target.id },
    });
    poolChanged(target.id);
    const [created] = await app.db.select().from(questions).where(eq(questions.id, id));
    return reply.code(201).send(await service.questionDetail(app.db, created!));
  });

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
    async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = PreviewBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    try {
      const loaded = await configOf(reply, scope.question, body.data.source);
      if (!loaded) return reply;
      const t = typeOf(scope.question.type);
      return {
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
    } catch (error) {
      return coreFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

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
    async (req, reply) => {
    const scope = await accessibleQuestion(app, req, reply);
    if (!scope) return reply;
    const body = TryBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    try {
      const loaded = await configOf(reply, scope.question, body.data.source);
      if (!loaded) return reply;
      const t = typeOf(scope.question.type);
      const answer =
        body.data.answer === undefined || body.data.answer === null
          ? null
          : t.answerSchema.parse(body.data.answer);
      const view = { seed: 0, itemId: scope.question.id, shuffle: false };
      const base: FinalizeContext = {
        seed: 0,
        itemId: scope.question.id,
        attemptId: randomUUID(),
        itemPoints: t.defaultPoints(loaded.config),
        now: new Date(),
      };
      const runner = runnerOf(app);
      const ctx: GradeContext = { ...base, runner: runner ?? unavailableRunner };
      const result = await t.grade(loaded.config, answer, ctx);

      if (result.kind === "graded") {
        return graded(result.points, result.maxPoints, result.details, t.toSolution(loaded.config, view));
      }
      if (result.via === "llm") return { status: "llm_unavailable" } satisfies TryResult;
      if (!runner || !t.finalizeRunner) {
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
      return coreFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" });
    }
  });

  // --- Assets ------------------------------------------------------------

  app.post("/app/api/pools/:id/assets", { preHandler: requireTeacher }, async (req, reply) => {
    const pool = await accessiblePool(app, req, reply);
    if (!pool) return reply;
    if (!req.isMultipart()) {
      return reply.code(415).send({ error: "unsupported_media_type", message: "Expected multipart/form-data" });
    }
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "validation", message: "No file in the request" });
    const bytes = await part.toBuffer();
    if (part.file.truncated) {
      return reply.code(413).send({
        error: "too_large",
        message: `Images are limited to ${config.ASSETS_MAX_BYTES} bytes`,
      });
    }
    // The bytes decide the type, not the header: an SVG (or anything else)
    // sniffs to nothing and is refused here.
    const facts = sniffImage(bytes);
    if (!facts || !isAllowedMime(facts.mime)) {
      return reply.code(415).send({
        error: "unsupported_media_type",
        message: "Only PNG, JPEG, GIF and WebP images are accepted",
      });
    }
    const sha256 = sha256Of(bytes);
    const path = pathForHash(sha256);
    const [existing] = await app.db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
    if (existing) {
      // Same bytes as an earlier upload: one row, one file, whoever uploaded
      // it first. Nothing is written a second time.
      return reply.code(200).send(assetJson(existing));
    }
    await writeAsset(config.ASSETS_DIR, path, bytes);
    const [created] = await app.db
      .insert(assets)
      .values({
        id: randomUUID(),
        ownerId: req.user!.id,
        poolId: pool.id,
        sha256,
        mime: facts.mime,
        bytes: bytes.length,
        width: facts.width,
        height: facts.height,
        path,
      })
      .onConflictDoNothing({ target: assets.sha256 })
      .returning();
    if (!created) {
      const [raced] = await app.db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
      return reply.code(200).send(assetJson(raced!));
    }
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "pool.asset_upload",
      subjectType: "asset",
      subjectId: created.id,
      payload: { poolId: pool.id, mime: created.mime, bytes: created.bytes },
    });
    return reply.code(201).send(assetJson(created));
  });

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

/**
 * Stands in for the real runner until WP3 decorates the app with one. It is
 * never reached by the grading worker (which WP6 owns); `POST /try` catches
 * its `RunnerUnavailable` and answers `runner_unavailable`.
 */
const unavailableRunner: RunnerService = {
  run() {
    return Promise.reject(new RunnerUnavailable("not_configured"));
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null, reason: "not_configured" });
  },
};
