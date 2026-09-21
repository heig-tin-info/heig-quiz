/**
 * HTTP surface of the bell (F-POOL-05).
 *
 * `requireSession`, not `teacherGuard`: a notification is addressed to an
 * ACCOUNT, and the kinds a student will receive (a released result, a
 * reopened attempt) belong to the same inbox.
 *
 * Ownership is never checked after the fact — it is part of every query
 * (invariant 6), so `POST /notifications/:id/read` on somebody else's row is
 * a 404 indistinguishable from a row that never existed.
 */
import type { FastifyInstance } from "fastify";

import { IdParam, NotificationQuery } from "@quiz/contracts";

import * as service from "./service.js";

export async function notificationsPlugin(app: FastifyInstance) {
  /** Any signed-in account; the inbox is per user, whatever their role. */
  const requireSession = (
    req: Parameters<FastifyInstance["requireSession"]>[0],
    reply: Parameters<FastifyInstance["requireSession"]>[1],
  ) => app.requireSession(req, reply);

  app.get("/app/api/notifications", { preHandler: requireSession }, async (req, reply) => {
    const query = NotificationQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "validation" });
    return service.listNotifications(app.db, req.user!.id, query.data.limit);
  });

  app.post("/app/api/notifications/:id/read", { preHandler: requireSession }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const found = await service.markRead(app.db, req.user!.id, params.data.id);
    if (!found) return reply.code(404).send({ error: "not_found" });
    return service.listNotifications(app.db, req.user!.id);
  });

  app.post("/app/api/notifications/read-all", { preHandler: requireSession }, async (req) => {
    await service.markAllRead(app.db, req.user!.id);
    return service.listNotifications(app.db, req.user!.id);
  });
}
