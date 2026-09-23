/**
 * `/app/api/me/tokens`: the settings screen's list of personal API tokens
 * (ADR-022). Teachers and admins only — a student has nothing to automate.
 *
 * These three routes refuse a caller authenticated BY a token: a leaked token
 * must not be able to mint its own replacement or hide its tracks by revoking
 * the others. Managing tokens takes a browser session, and therefore edu-ID.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiTokenCreate, IdParam } from "@quiz/contracts";

import { audit } from "../audit.js";
import { teacherGuard } from "../modules/guards.js";
import { invalid, notFound } from "../modules/http.js";
import { createApiToken, listApiTokens, revokeApiToken } from "./tokens.js";

/**
 * A teacher in a BROWSER: the guard of every route that manages credentials
 * (tokens, OAuth consent, connected assistants). A caller authenticated by a
 * token is refused, so no token can mint, approve or revoke another.
 */
export function sessionTeacherGuard(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await requireTeacher(req, reply);
    if (denied) return denied;
    if (req.authVia === "token") return reply.code(403).send({ error: "session_required" });
    return undefined;
  };
}

export async function apiTokenRoutes(app: FastifyInstance) {
  const sessionOnly = sessionTeacherGuard(app);

  app.get("/app/api/me/tokens", { preHandler: sessionOnly }, async (req) =>
    listApiTokens(app.db, req.user!.id),
  );

  app.post("/app/api/me/tokens", { preHandler: sessionOnly }, async (req, reply) => {
    const body = ApiTokenCreate.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const created = await createApiToken(app.db, req.user!.id, body.data, app.clock.now());
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "api_token.create",
      subjectType: "api_token",
      subjectId: created.id,
      payload: { name: created.name, expiresAt: created.expiresAt },
    });
    return reply.code(201).send(created);
  });

  app.delete("/app/api/me/tokens/:id", { preHandler: sessionOnly }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const revoked = await revokeApiToken(app.db, req.user!.id, params.data.id, app.clock.now());
    if (!revoked) return notFound(reply);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "api_token.revoke",
      subjectType: "api_token",
      subjectId: revoked.id,
      payload: { name: revoked.name },
    });
    return revoked;
  });
}
