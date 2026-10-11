/**
 * The training course's two routes (ADR-105 §1 and §4): a teacher's or an
 * administrator's OWN portal session — never a student, a personal API
 * token, an OAuth token, a `seb` or `kiosk` session, nor a session acting
 * as somebody else (ADR-034) — the predicate the teacher assistant's routes
 * use (`teacherGuard` then `ownSessionGuard`). The course itself is an
 * ordinary course everywhere else: `staffAccess` reaches it.
 */
import type { FastifyInstance } from "fastify";

import { actorOf } from "../../audit.js";
import { publish } from "../../events.js";
import { ownSessionGuard, teacherGuard } from "../guards.js";
import { readerLang, sendFailure } from "../http.js";
import { provision, status } from "./service.js";

export async function trainingPlugin(app: FastifyInstance) {
  const requireTraining = [teacherGuard(app), ownSessionGuard(app)];

  app.get("/app/api/training", { preHandler: requireTraining }, async (req) =>
    status(app.db, { userId: req.user!.id, llmEnabled: app.llmGateway.enabled }),
  );

  // Provisions the caller's course in the UI language of the request, or
  // answers the existing one: 201 when created, 200 when found.
  app.post("/app/api/training", { preHandler: requireTraining }, async (req, reply) => {
    const now = app.clock.now();
    const userId = req.user!.id;
    try {
      const result = await provision(app.db, { userId, lang: readerLang(req), now, actor: actorOf(req) });
      if (result.created) publish("courses", [`teacher:${userId}`]);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return sendFailure(reply, error, now);
    }
  });
}
