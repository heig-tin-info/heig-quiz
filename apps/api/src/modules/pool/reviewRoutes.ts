/**
 * The LLM review (ADR-060 §6): the pool's tab, the owner's switch, and on a
 * question "Review now", Ignore and Fix. Whoever reaches the pool reads
 * (a 404 otherwise, invariant 6); acting needs `contributor`, the switch
 * `owner`.
 */
import type { FastifyInstance } from "fastify";

import { IdParam, ReviewFixBody, ReviewToggle } from "@quiz/contracts";

import { Budget, BUDGET_RETRY_AFTER_S } from "../../budget.js";
import { rateLimited } from "../http.js";
import { poolChanged } from "./events.js";
import { applyReviewFix, reviewVersion } from "./review.js";
import { ignoreReview, latestVersionOf, poolReviews, reviewJson, reviewOf, setReviewEnabled } from "./reviewStore.js";
import { LLM_CALLS_PER_MINUTE, type PoolRouteContext } from "./routeContext.js";

export function reviewRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, teacher, inPool, onQuestion } = ctx;

  app.get(
    "/app/api/pools/:id/reviews",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: inPool() }, async ({ scope: pool }) => poolReviews(app.db, pool.id)),
  );

  app.put(
    "/app/api/pools/:id/review",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: ReviewToggle, load: inPool("owner") }, async ({ req, body, scope: pool }) => {
      await setReviewEnabled(app.db, pool.id, body.enabled, req.user!.id);
      await trace(req, "pool.review", "pool", pool.id, { enabled: body.enabled });
      poolChanged(pool.id);
      return poolReviews(app.db, pool.id);
    }),
  );

  /** "Review now": the latest published version, by the teacher's call, whether the pool asked or not. */
  const calls = new Budget();
  app.post(
    "/app/api/questions/:id/review",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion("contributor") }, async ({ req, reply, scope }) => {
      if (!calls.spend(`review:${req.user!.id}`, LLM_CALLS_PER_MINUTE, app.clock.now())) {
        return rateLimited(reply, BUDGET_RETRY_AFTER_S);
      }
      const version = await latestVersionOf(app.db, scope.question.id);
      if (!version) return reply.code(400).send({ error: "not_published" });
      const review = await reviewVersion(
        app.db,
        app.llmGateway,
        { id: version.id, number: version.number!, type: scope.question.type, config: version.config, explanation: version.explanation },
        req.user!.id,
        app.clock.now(),
      );
      poolChanged(scope.pool.id);
      return review;
    }),
  );

  /** The latest version's review, or the refusal that it has none. */
  const latestReview = async (questionId: string) => {
    const version = await latestVersionOf(app.db, questionId);
    const review = version ? await reviewOf(app.db, version.id) : null;
    return version && review ? { version, review } : null;
  };

  app.post(
    "/app/api/questions/:id/review/ignore",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: onQuestion("contributor") }, async ({ req, reply, scope }) => {
      const latest = await latestReview(scope.question.id);
      if (!latest) return reply.code(400).send({ error: "no_review" });
      const row = await ignoreReview(app.db, latest.version.id, req.user!.id, app.clock.now());
      poolChanged(scope.pool.id);
      return reviewJson(row!, latest.version.number!);
    }),
  );

  app.post(
    "/app/api/questions/:id/review/fix",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: ReviewFixBody, load: onQuestion("contributor") }, async ({ reply, body, scope }) => {
      const latest = await latestReview(scope.question.id);
      if (!latest) return reply.code(400).send({ error: "no_review" });
      const findings = await applyReviewFix(
        app.db,
        scope.question,
        { versionId: latest.version.id, findings: latest.review.findings },
        body.finding,
        body.undo === true,
      );
      poolChanged(scope.pool.id);
      return reviewJson({ ...latest.review, findings }, latest.version.number!);
    }),
  );
}
