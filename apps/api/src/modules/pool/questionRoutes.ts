/** Questions: list, create, read, edit, publish, versions, delete, copy. */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CopyBody,
  DeprecateBody,
  DraftPut,
  BoolFlag,
  GenerateRequest,
  SuggestConceptsRequest,
  IdParam,
  PublishBody,
  QuestionCreate,
  QuestionPatch,
  QuestionSearch,
  VersionParam,
  type StatsReset,
} from "@quiz/contracts";

import { registeredServerIds } from "@quiz/registry/server";

import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import { iso, isoOrNull } from "../../clock.js";
import { questions } from "../../db/schema.js";
import { actorOf } from "../../audit.js";
import { callerOf, findAccessiblePool, requirePoolRole } from "../guards.js";
import { rateLimited, readerLang } from "../http.js";
import { poolChanged } from "./events.js";
import { GenerateRefusal, generateAnswers, generatorTypes } from "./generate.js";
import { draftTextOf } from "./config.js";
import { suggestConcepts, SUGGEST_DRAFT_MAX } from "../concept/service.js";
import * as service from "./service.js";
import { LLM_CALLS_PER_MINUTE } from "../llm/service.js";
import { coreFailure, type PoolRouteContext } from "./routeContext.js";

export function questionRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, onQuestion, seesAllReports } = ctx;

  app.get(
    "/app/api/pools/:id/questions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: QuestionSearch, load: inPool() },
      async ({ req, reply, query, scope: pool }) => {
        try {
          const viewer = { id: req.user!.id, seesAll: await seesAllReports(req, pool) };
          return await service.listQuestions(app.db, pool.id, viewer, query, readerLang(req));
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
        // A name the pool already holds is `questionWriteError`'s 409 `duplicate_name`, a category of
        // another pool the 404 of `poolFailure`, a type the registry refuses
        // the 422 of `coreFailure`.
        const created = await service.createQuestion(app.db, {
          poolId: pool.id,
          type: body.type,
          internalName: body.internalName,
          categoryId: body.categoryId ?? null,
          createdBy: req.user!.id,
          // A concept that cannot be resolved is the 422 `ConceptWriteRefusal`, and nothing is created.
          concepts: body.concepts && {
            inputs: body.concepts,
            createMissing: body.createMissing ?? false,
            writer: { userId: req.user!.id, lang: readerLang(req), actor: actorOf(req) },
          },
        });
        await trace(req, "question.create", "question", created.id, {
          poolId: pool.id,
          type: body.type,
          internalName: body.internalName,
          ...(body.concepts ? { concepts: body.concepts } : {}),
        });
        poolChanged(pool.id);
        return reply.code(201).send(await service.questionDetail(app.db, created, readerLang(req)));
      },
    ),
  );

  app.get(
    "/app/api/questions/:id",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion() }, ({ req, scope }) =>
      service.questionDetail(app.db, scope.question, readerLang(req)),
    ),
  );

  app.patch(
    "/app/api/questions/:id",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: QuestionPatch, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        // `questionWriteError`'s 409 `duplicate_name` and `poolFailure`'s 404, like the create route.
        // A concept that cannot be resolved is the 422 `ConceptWriteRefusal`.
        await service.patchQuestion(app.db, scope.question, body, {
          userId: req.user!.id,
          lang: readerLang(req),
          actor: actorOf(req),
        });
        await trace(req, "question.update", "question", scope.question.id, body);
        poolChanged(scope.pool.id);
        const [fresh] = await app.db
          .select()
          .from(questions)
          .where(eq(questions.id, scope.question.id));
        return (await service.questionDetail(app.db, fresh!, readerLang(req))).meta;
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
          explanation: body.explanation,
          variables: body.variables,
        });
        poolChanged(scope.pool.id);
        return saved;
      },
    ),
  );

  /**
   * "Generate answers" (ADR-059): the editor's draft as it stands, completed
   * by the model through the type's generator, sent back — never stored here.
   * A contributor's, like the draft it completes. A few per minute per
   * teacher: a guard against a held-down button, the gateway's cap does the
   * rest.
   */
  const generations = new Budget();
  app.post(
    "/app/api/questions/:id/generate",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: GenerateRequest, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        if (!generations.spend(`generate:${req.user!.id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
          return rateLimited(reply, BUDGET_RETRY_AFTER_S);
        }
        return generateAnswers(app.llmGateway, app.runner, {
          type: scope.question.type,
          config: body.config,
          explanation: body.explanation,
          item: body.item,
          userId: req.user!.id,
        });
      },
    ),
  );

  /**
   * "Suggest concepts" (ADR-081 sixth addendum §6): the draft's text, as the
   * type searches it, against the vocabulary; nothing is stored. A
   * contributor's, like the wand, and under the same per-minute guard.
   */
  const suggestions = new Budget();
  app.post(
    "/app/api/questions/:id/suggest-concepts",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: SuggestConceptsRequest, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        const draft = draftTextOf(scope.question.type, body.config).slice(0, SUGGEST_DRAFT_MAX);
        if (draft === "") throw new GenerateRefusal("statement_empty");
        if (!suggestions.spend(`suggest:${req.user!.id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
          return rateLimited(reply, BUDGET_RETRY_AFTER_S);
        }
        return suggestConcepts(app.db, app.llmGateway, {
          questionId: scope.question.id,
          draft,
          userId: req.user!.id,
          lang: readerLang(req),
        });
      },
    ),
  );

  /**
   * Whether the wand can work now, and the types that have one (ADR-059).
   * Here and not in the llm module: the wand is the editor's, and which
   * types have one is the registry's, which the llm module does not read.
   */
  app.get("/app/api/generate/availability", { preHandler: requireTeacher }, async () => ({
    available: await app.llmGateway.ready(),
    types: generatorTypes(registeredServerIds()),
  }));

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
    teacher({ params: IdParam, path: VersionParam, load: onQuestion() }, async ({ reply, path, scope }) => {
      const version = await service.versionDetail(app.db, scope.question, path.number);
      if (!version) return reply.code(404).send({ error: "not_found" });
      return version;
    }),
  );

  app.post(
    "/app/api/questions/:id/versions/:number/restore",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, path: VersionParam, load: onQuestion("contributor") }, async ({ req, reply, path, scope }) => {
      const done = await service.restoreVersion(app.db, scope.question, path.number);
      if (!done) return reply.code(404).send({ error: "not_found" });
      await trace(req, "question.restore_version", "question", scope.question.id, { number: path.number });
      poolChanged(scope.pool.id);
      const [fresh] = await app.db
        .select()
        .from(questions)
        .where(eq(questions.id, scope.question.id));
      return service.questionDetail(app.db, fresh!, readerLang(req));
    }),
  );

  app.post(
    "/app/api/questions/:id/versions/:number/deprecate",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, path: VersionParam, body: DeprecateBody, load: onQuestion("contributor") },
      async ({ req, reply, path, body, scope }) => {
        const version = await service.deprecateVersion(app.db, scope.question.id, path.number, body.note);
        if (!version) return reply.code(404).send({ error: "not_found" });
        await trace(req, "question.deprecate", "question", scope.question.id, { number: path.number, note: body.note });
        poolChanged(scope.pool.id);
        return version;
      },
    ),
  );

  /**
   * F-STAT-05 (ADR-038): the question's statistics start again from now.
   * Nothing is deleted; the reads are the `stats` module's.
   */
  app.post(
    "/app/api/questions/:id/stats/reset",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion("contributor") }, async ({ req, scope }) => {
      const now = app.clock.now();
      await service.resetQuestionStats(app.db, scope.question.id, now);
      await trace(req, "question.stats_reset", "question", scope.question.id, {
        poolId: scope.pool.id,
        previousSince: isoOrNull(scope.question.statsSince),
      });
      poolChanged(scope.pool.id);
      return { since: iso(now) } satisfies StatsReset;
    }),
  );

  const DeleteQuery = z.object({ hard: BoolFlag.optional() });

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
        const target = await findAccessiblePool(app.db, callerOf(req), body.targetPoolId);
        if (!target) return reply.code(404).send({ error: "not_found" });
        // Reading the source is enough to copy FROM it; writing the copy needs a
        // contributor's seat on the TARGET.
        if (!(await requirePoolRole(app, req, reply, target, "contributor"))) return reply;
        // A category of another pool is `CategoryNotInPool`, `poolFailure`'s 404.
        const created = await service.copyQuestion(app.db, scope.question, {
          targetPoolId: target.id,
          categoryId: body.categoryId ?? null,
          userId: req.user!.id,
        });
        await trace(req, "question.copy", "question", created.id, {
          from: scope.question.id,
          targetPoolId: target.id,
        });
        poolChanged(target.id);
        return reply.code(201).send(await service.questionDetail(app.db, created, readerLang(req)));
      },
    ),
  );
}
