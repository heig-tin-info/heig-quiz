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
 * The admin's, with the admin role alone — no Super Powers (ADR-081 second
 * addendum §4, an exception to ADR-054 §2 for the sorting only):
 *
 * - `GET /app/api/admin/concept-sorting`: every (pool, tag) pair to sort.
 * - `POST /app/api/admin/concept-sorting/accept`: the decisions, in one
 *   transaction, and the links of a pair accepted into a concept; 409
 *   `concept_exists` (with `conflicts`), 409 `sorting_locked` (with
 *   `items`) for a pair already accepted, 422 `tag_unknown`,
 *   `concept_not_found` or `concept_batch_conflict` (with `items`).
 * - `POST /app/api/admin/concept-sorting/propose`: starts the model pass
 *   that proposes the sorting (`./propose.ts`); 202 with the run; 409
 *   `concept_sort_running` while one is alive, 409 `llm_not_configured`
 *   without a usable model.
 * - `GET /app/api/admin/concept-sorting/run`: the last run, null before the first.
 * - `POST /app/api/admin/concepts/:id/validate`: 422
 *   `concept_label_missing`, 409 `concept_merged`, 404.
 * - `DELETE /app/api/admin/concepts/:id`: 204; 409 `concept_in_use`, 404.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ConceptCreate,
  type ConceptSortRunStatus,
  type ConceptList,
  ConceptPatch,
  ConceptResolveQuery,
  type ConceptResolveResponse,
  IdParam,
  TagSortingAccept,
  type TagSortingAcceptResponse,
  type TagSortingList,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import { adminGuard, callerOf, teacherGuard } from "../guards.js";
import { invalid, notFound, readerLang, sendFailure } from "../http.js";
import { llmArms } from "../llm/service.js";
import * as service from "./service.js";

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

  app.get("/app/api/admin/concept-sorting", { preHandler: requireAdmin }, async () => {
    return { rows: await service.listTagSortings(app.db) } satisfies TagSortingList;
  });

  app.post("/app/api/admin/concept-sorting/accept", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    const body = TagSortingAccept.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const ctx = { userId: callerOf(req).id, actor: actorOf(req), now };
      return (await service.acceptTagSortings(app.db, ctx, body.data.items)) satisfies TagSortingAcceptResponse;
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });

  app.post("/app/api/admin/concept-sorting/propose", { preHandler: requireAdmin }, async (req, reply) => {
    const now = app.clock.now();
    try {
      const run = await service.startSortRun(app, { userId: callerOf(req).id, actor: actorOf(req), now });
      return reply.code(202).send({ run } satisfies ConceptSortRunStatus);
    } catch (error) {
      return sendFailure(reply, error, now, llmArms);
    }
  });

  app.get("/app/api/admin/concept-sorting/run", { preHandler: requireAdmin }, async () => {
    return { run: await service.lastSortRun(app, app.clock.now()) } satisfies ConceptSortRunStatus;
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
