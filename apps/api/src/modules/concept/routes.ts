/**
 * HTTP surface of the `concept` module (ADR-081, addendum 2026-10-08 §1a):
 * the vocabulary of concepts, connected to nothing yet. Teachers only (an
 * admin passes the guard); the vocabulary is the instance's, not anyone's
 * content, so there is no entity to load through an access predicate — the
 * rights on a concept are the service's (addendum §5).
 *
 * - `GET /app/api/concepts`: every concept that is not merged.
 * - `POST /app/api/concepts/resolve`: what each typed label designates.
 * - `POST /app/api/concepts`: a `proposed` concept; 409 `concept_exists`.
 * - `PATCH /app/api/concepts/:id`: 403 `concept_forbidden`, 409
 *   `concept_merged` or `concept_exists`, 422 `concept_label_missing`, 404
 *   for an unknown id.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ConceptCreate,
  type ConceptList,
  ConceptPatch,
  ConceptResolveRequest,
  type ConceptResolveResponse,
  IdParam,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import { callerOf, teacherGuard } from "../guards.js";
import { invalid, notFound, sendFailure } from "../http.js";
import * as service from "./service.js";

export async function conceptPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const context = (req: FastifyRequest, now: Date): service.ConceptContext => ({
    caller: callerOf(req),
    actor: actorOf(req),
    now,
  });

  app.get("/app/api/concepts", { preHandler: requireTeacher }, async () => {
    return { concepts: await service.listConcepts(app.db) } satisfies ConceptList;
  });

  app.post("/app/api/concepts/resolve", { preHandler: requireTeacher }, async (req, reply) => {
    const body = ConceptResolveRequest.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return { results: await service.resolveLabels(app.db, body.data.inputs) } satisfies ConceptResolveResponse;
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
}
