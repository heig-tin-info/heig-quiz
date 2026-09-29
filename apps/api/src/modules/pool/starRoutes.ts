/**
 * Favourite stars (F-POOL-10, ADR-039): a teacher's own bookmarks on the
 * questions they can see.
 *
 * Starring is a PREFERENCE, not an edit: any role that reaches the pool may
 * star — a reader, and anyone on a public pool — so no pool role is asked for.
 * Nothing is audited and no refresh hint is sent: nobody but the caller sees
 * a star, and the caller's own screen updated itself before asking.
 */
import type { FastifyInstance } from "fastify";

import { IdParam, QuestionStarBody, type StarsCleared } from "@quiz/contracts";

import { invalid, notFound } from "../http.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function starRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, teacher, inPool, questionsInReach } = ctx;

  // Not `teacher({...})`: it loads ONE entity from the path's `:id`, and a
  // batch has no path id — its scope is `questionsInReach`, like the move's.
  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/app/api/questions/star",
      preHandler: requireTeacher,
      handler: async (req, reply) => {
        const body = QuestionStarBody.safeParse(req.body);
        if (!body.success) return invalid(reply, body.error);
        const ids = [...new Set(body.data.questionIds)];
        if ((await questionsInReach(req, ids)).length !== ids.length) return notFound(reply);
        const write = method === "PUT" ? service.starQuestions : service.unstarQuestions;
        await write(app.db, req.user!.id, ids);
        return reply.code(204).send();
      },
    });
  }

  app.delete(
    "/app/api/pools/:id/stars",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ req, scope: pool }) => {
      const cleared: StarsCleared = {
        cleared: await service.clearPoolStars(app.db, req.user!.id, pool.id),
      };
      return cleared;
    }),
  );
}
