/**
 * HTTP surface of the `concept` module (ADR-081, addendum 2026-10-08): the
 * vocabulary of concepts that classifies the questions. Teachers only (an
 * admin passes the guard); the vocabulary is the instance's, not anyone's
 * content, so there is no entity to load through an access predicate — the
 * rights on a concept are the service's (addendum §5).
 *
 * - `GET /app/api/concepts`: every concept that is not merged.
 * - `GET /app/api/concepts/resolve?input=…`: what each typed label
 *   designates; a read, so the teacher assistant may call it.
 * - `POST /app/api/concepts`: a `proposed` concept; 409 `concept_exists`;
 *   422 `concept_dropped`, for a teacher, for an unqualified label whose key
 *   is a tag the admin dropped (third addendum §4 as amended,
 *   `ConceptWriteRefusal`); `PATCH` likewise for an edit onto such a key.
 * - `PATCH /app/api/concepts/:id`: 403 `concept_forbidden`, 409
 *   `concept_merged` or `concept_exists`, 422 `concept_label_missing`, 404
 *   for an unknown id.
 *
 * The admin's, with the admin role alone:
 *
 * - `GET /app/api/admin/concepts`: the curation queue, with the instance-wide count of questions using each concept (a number;
 *   Super Powers are not needed, ADR-054 amended).
 * - `POST /app/api/admin/concepts/duplicates/ai` (no body): the model's probable
 *   duplicate pairs, from labels and qualifiers alone (fifth addendum §4,
 *   purpose `concepts`); nothing stored. 409 `llm_not_configured`, 429
 *   `llm_budget_exhausted` or `rate_limited`, 502 `llm_failed`.
 * - `POST /app/api/admin/concepts/:id/validate`: 422
 *   `concept_label_missing`, 409 `concept_merged`, 404.
 * - `POST /app/api/admin/concepts/:id/aliases` `{ alias, force? }`: adds a
 *   curated alias (ADR-081 §6), answering the concept; 409
 *   `alias_collision` (its key is another concept's label or alias; resent
 *   with `force` it is stored), 409 `alias_exists`, 422 `alias_redundant`
 *   (the concept's own label), 409 `concept_merged`, 404.
 *   `DELETE .../aliases/:alias` (the alias as written) removes one, answering the concept.
 * - `DELETE /app/api/admin/concepts/:id`: 204; 409 `concept_in_use`, 404.
 * - `POST /app/api/admin/concepts/:id/merge` `{ into }`: merges the concept
 *   (`keepAsAlias`: its labels stay as aliases of the winner) into a validated one, answering the winner (`Concept`); 422
 *   `concept_merge_self` or `concept_merge_target_not_validated`, 409
 *   `concept_merged` (either side already merged), 404 (either unknown).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  type AdminConceptList,
  ConceptAliasAdd,
  ConceptAliasParams,
  ConceptCreate,
  ConceptMerge,
  type ConceptList,
  ConceptPatch,
  ConceptResolveQuery,
  type ConceptResolveResponse,
  IdParam,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import { adminGuard, callerOf, teacherGuard } from "../guards.js";
import { invalid, notFound, rateLimited, readerLang, sendFailure } from "../http.js";
import { llmArms } from "../llm/service.js";
import { aiDuplicates } from "./duplicatesAi.js";
import * as service from "./service.js";

/** A double click, not a quota: the gateway's daily cap is the ceiling (ADR-059). */
const ASKS_PER_MINUTE = 5;

export async function conceptPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const requireAdmin = adminGuard(app);
  const context = (req: FastifyRequest, now: Date): service.ConceptContext => ({
    caller: callerOf(req),
    actor: actorOf(req),
    now,
  });

  app.get("/app/api/concepts", { preHandler: requireTeacher }, async () => {
    return { concepts: await service.listConcepts(app.db) } satisfies ConceptList;
  });

  app.get("/app/api/concepts/resolve", { preHandler: requireTeacher }, async (req, reply) => {
    const query = ConceptResolveQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const results = await service.resolveLabels(app.db, query.data.input, readerLang(req), callerOf(req));
    return { results } satisfies ConceptResolveResponse;
  });

  app.post("/app/api/concepts", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const body = ConceptCreate.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      return reply.code(201).send(await service.createConcept(app.db, context(req, now), body.data));
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.patch("/app/api/concepts/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = ConceptPatch.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      return await service.patchConcept(app.db, context(req, now), params.data.id, body.data);
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.get("/app/api/admin/concepts", { preHandler: requireAdmin }, async () => {
    return { concepts: await service.listAdminConcepts(app.db) } satisfies AdminConceptList;
  });

  const asks = new Budget();
  app.post("/app/api/admin/concepts/duplicates/ai", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    if (!asks.spend(`concepts:${req.user!.id}`, ASKS_PER_MINUTE, now)) return rateLimited(reply, BUDGET_RETRY_AFTER_S);
    try {
      return await aiDuplicates(app.db, app.llmGateway, req.user!.id);
    } catch (error) {
      return sendFailure(reply, error, now, llmArms);
    }
  });

  app.post("/app/api/admin/concepts/:id/validate", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    try {
      return await service.validateConcept(app.db, { actor: actorOf(req), now }, params.data.id);
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.post("/app/api/admin/concepts/:id/merge", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = ConceptMerge.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      return await service.mergeConcept(app.db, context(req, now), params.data.id, body.data.into, body.data.keepAsAlias);
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.post("/app/api/admin/concepts/:id/aliases", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = ConceptAliasAdd.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      return await service.addAlias(app.db, context(req, now), params.data.id, body.data, readerLang(req));
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.delete("/app/api/admin/concepts/:id/aliases/:alias", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const params = ConceptAliasParams.safeParse(req.params);
    if (!params.success) return notFound(reply);
    try {
      return await service.removeAlias(app.db, context(req, now), params.data.id, params.data.alias);
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.delete("/app/api/admin/concepts/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    try {
      await service.deleteConcept(app.db, { actor: actorOf(req), now }, params.data.id);
      return reply.code(204).send();
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });
}
