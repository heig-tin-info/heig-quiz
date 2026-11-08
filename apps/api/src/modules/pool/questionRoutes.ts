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

import { questionType, registeredServerIds } from "@quiz/registry/server";

import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import { iso, isoOrNull } from "../../clock.js";
import { questions } from "../../db/schema.js";
import { actorOf } from "../../audit.js";
import { callerOf, findAccessiblePool, requirePoolRole } from "../guards.js";
import { notFound, rateLimited, readerLang } from "../http.js";
import { poolChanged } from "./events.js";
import { GenerateRefusal, generateAnswers, generatorTypes } from "./generate.js";
import { questionExcerpt } from "./excerpt.js";
import { suggestConcepts, SUGGEST_DRAFT_MAX } from "../concept/service.js";
import * as service from "./service.js";
import { LLM_CALLS_PER_MINUTE } from "../llm/service.js";
import { coreFailure, type PoolRouteContext } from "./routeContext.js";

export function questionRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, poolWrite, teacher, inPool, onQuestion, seesAllReports } = ctx;

  app.get(
    "/app/api/pools/:id/questions",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: QuestionSearch, load: inPool() },
      async ({ req, reply, query, scope: pool }) => {
        try {
          const viewer = { id: callerOf(req).id, seesAll: await seesAllReports(req, pool) };
          // A course the caller does not staff, or the pool is not linked to, is a missing one (#599 step 7b).
          const courseConcepts =
            query.course === undefined
              ? undefined
              : await service.courseFilterConcepts(app.db, pool.id, callerOf(req), query.course);
          if (courseConcepts === null) return notFound(reply);
          return await service.listQuestions(app.db, pool.id, viewer, query, readerLang(req), courseConcepts);
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
        const { type, internalName, concepts } = body;
        const write = () =>
          service.createQuestion(app.db, {
            poolId: pool.id,
            type,
            internalName,
            categoryId: body.categoryId ?? null,
            createdBy: callerOf(req).id,
            // A concept that cannot be resolved is the 422 `ConceptWriteRefusal`, and nothing is created.
            concepts: concepts && {
              inputs: concepts,
              createMissing: body.createMissing ?? false,
              writer: { userId: callerOf(req).id, lang: readerLang(req), actor: actorOf(req) },
            },
          });
        const created = await poolWrite(req, pool.id, write, (row) => [
          "question.create", "question", row.id, { poolId: pool.id, type, internalName, ...(concepts ? { concepts } : {}) },
        ]);
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
        const writer = { userId: callerOf(req).id, lang: readerLang(req), actor: actorOf(req) };
        await poolWrite(req, scope.pool.id, () => service.patchQuestion(app.db, scope.question, body, writer), () => [
          "question.update", "question", scope.question.id, body,
        ]);
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
        if (!generations.spend(`generate:${callerOf(req).id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
          return rateLimited(reply, BUDGET_RETRY_AFTER_S);
        }
        return generateAnswers(app.llmGateway, app.runner, {
          type: scope.question.type,
          config: body.config,
          explanation: body.explanation,
          item: body.item,
          target: body.target,
          userId: callerOf(req).id,
        });
      },
    ),
  );

  /**
   * "Suggest concepts" (ADR-081 sixth addendum §6): the draft's student-view
   * excerpt (statement and choices, no answer key) against the vocabulary;
   * nothing is stored. A contributor's, like the wand, and under the same
   * per-minute guard (its own counter per teacher).
   */
  app.post(
    "/app/api/questions/:id/suggest-concepts",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: SuggestConceptsRequest, load: onQuestion("contributor") },
      async ({ req, reply, body, scope }) => {
        const type = scope.question.type;
        const draft = questionExcerpt(
          type,
          { config: body.config, configVersion: questionType(type).configVersion, variables: null },
          SUGGEST_DRAFT_MAX,
        );
        // No excerpt: no statement, or a draft that does not parse yet — the wand's own refusal.
        if (draft === null) throw new GenerateRefusal("statement_empty");
        if (!generations.spend(`suggest:${callerOf(req).id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
          return rateLimited(reply, BUDGET_RETRY_AFTER_S);
        }
        return suggestConcepts(app.db, app.llmGateway, {
          questionId: scope.question.id,
          draft,
          userId: callerOf(req).id,
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
          const note = body.changeNote !== undefined ? { changeNote: body.changeNote } : {};
          const write = () => service.publishQuestion(app.db, scope.question, { userId: callerOf(req).id, ...note });
          const version = await poolWrite(req, scope.pool.id, write, ({ number, changeNote }) => [
            "question.publish", "question", scope.question.id, { number, changeNote },
          ]);
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
      const write = () => service.restoreVersion(app.db, scope.question, path.number);
      const done = await poolWrite(req, scope.pool.id, write, (ok) =>
        ok ? ["question.restore_version", "question", scope.question.id, { number: path.number }] : null);
      if (!done) return reply.code(404).send({ error: "not_found" });
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
        const write = () => service.deprecateVersion(app.db, scope.question.id, path.number, body.note);
        const version = await poolWrite(req, scope.pool.id, write, (v) =>
          v ? ["question.deprecate", "question", scope.question.id, { number: path.number, note: body.note }] : null);
        return version ?? reply.code(404).send({ error: "not_found" });
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
      await poolWrite(req, scope.pool.id, () => service.resetQuestionStats(app.db, scope.question.id, now), () => [
        "question.stats_reset", "question", scope.question.id,
        { poolId: scope.pool.id, previousSince: isoOrNull(scope.question.statsSince) },
      ]);
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
        const remove = query.hard ? service.hardDeleteQuestion : service.softDeleteQuestion;
        try {
          await poolWrite(req, scope.pool.id, () => remove(app.db, scope.question), () => [
            "question.delete", "question", scope.question.id,
            { hard: query.hard === true, internalName: scope.question.internalName },
          ]);
        } catch (error) {
          if (error instanceof service.VersionInUse) {
            return reply.code(409).send({
              error: "in_use",
              message: "An evaluation still uses a published version of this question",
            });
          }
          throw error;
        }
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
        const into = { targetPoolId: target.id, categoryId: body.categoryId ?? null, userId: callerOf(req).id };
        const write = () => service.copyQuestion(app.db, scope.question, into);
        const created = await poolWrite(req, target.id, write, (row) => [
          "question.copy", "question", row.id, { from: scope.question.id, targetPoolId: target.id },
        ]);
        return reply.code(201).send(await service.questionDetail(app.db, created, readerLang(req)));
      },
    ),
  );
}
