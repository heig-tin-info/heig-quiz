/**
 * HTTP surface of the `results` module (PLAN-MVP §4.6).
 *
 * The teacher half serves the grade table, the statistics, the per-question
 * view and the CSV; the student half serves exactly one thing — their own
 * attempt, through the feedback policy, and only once the results are
 * released.
 *
 * The student route goes through `studentFeedback()` and nothing else: it is
 * the second half of the content gate of docs/05 §5.7, and the reason the
 * route itself contains no policy logic at all.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdParam, ReleaseBody } from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { iso } from "../../clock.js";
import { loadEvaluation, ownAttempt, teacherGuard } from "../guards.js";
import { studentRoute, teacherRoute } from "../http.js";
import { byId } from "../evaluation/service.js";
import * as gradingEvents from "../grading/events.js";
import * as bus from "../realtime/bus.js";
import { csvFilename, resultsCsv } from "./csv.js";
import * as service from "./service.js";

export async function resultsPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const requireSession = (req: FastifyRequest, reply: FastifyReply) =>
    app.requireSession(req, reply);

  /** Maps every failure of the module to its status; the rest is a 500. */
  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof service.ResultsError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    app.log.error({ err: error, cause: (error as Error)?.cause }, "results route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);
  const student = studentRoute(app, failure);

  const trace = tracer(app);

  // The loaders of invariant 6, each answering its own 404.
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const own = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    ownAttempt(app, req, reply, p.id);

  // --- Teacher -----------------------------------------------------------

  app.get(
    "/app/api/evaluations/:id/results",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.resultsView(app.db, scope.evaluation),
    ),
  );

  /** F-RES-02. UTF-8 with a BOM and `;`, because Excel is the reader. */
  app.get(
    "/app/api/evaluations/:id/results.csv",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ reply, scope }) => {
      const view = await service.resultsView(app.db, scope.evaluation);
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${csvFilename(scope.evaluation.title)}"`,
        )
        .send(resultsCsv(view));
    }),
  );

  /** F-RES-03: the linear walk through the questions for the class debrief. */
  app.get(
    "/app/api/evaluations/:id/results/by-question",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.byQuestion(app.db, scope.evaluation),
    ),
  );

  /**
   * F-RES-04. The snapshot and the instant are written together (§4.6), the
   * state moves to `released`, and every student of the classroom is told to
   * re-read their own results.
   */
  app.post(
    "/app/api/evaluations/:id/release",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ReleaseBody, optionalBody: true, load: staffEvaluation },
      async ({ req, now, scope }) => {
        const again = scope.evaluation.releasedAt !== null;
        const released = await service.releaseResults(app.db, scope.evaluation, now);
        const action = again ? "results.rerelease" : "results.release";
        await trace(req, action, "evaluation", scope.evaluation.id, { rows: released.rows });
        await announce(scope.evaluation.id);
        return { releasedAt: iso(released.releasedAt), rows: released.rows, released: true };
      },
    ),
  );

  /** Withdrawing a release (a wrong key, a question to re-grade first). */
  app.post(
    "/app/api/evaluations/:id/unrelease",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ req, now, scope }) => {
      await service.unreleaseResults(app.db, scope.evaluation, now);
      await trace(req, "results.unrelease", "evaluation", scope.evaluation.id);
      await announce(scope.evaluation.id);
      return { releasedAt: null, rows: 0, released: false };
    }),
  );

  // --- Student -----------------------------------------------------------

  /** One card per released evaluation the student took (F-RES-04). */
  app.get("/app/api/student/results", { preHandler: requireSession }, async (req) =>
    service.studentResultCards(app.db, req.user!.id),
  );

  /**
   * THE student feedback view. Before the release — or under a policy that
   * shows nothing — the answer carries a reason and no question content at
   * all (`available: false`).
   */
  app.get(
    "/app/api/attempts/:id/feedback",
    { preHandler: requireSession },
    student({ params: IdParam, load: own }, ({ scope }) =>
      service.studentFeedback(app.db, scope.evaluation, scope.attempt),
    ),
  );

  /**
   * The release and its withdrawal are state changes, so they go out as the
   * typed `evaluation.state` event AND as a `results` hint for the students,
   * who do not watch the evaluation topic outside a live session.
   */
  async function announce(evaluationId: string): Promise<void> {
    const row = await byId(app.db, evaluationId);
    if (!row) return;
    bus.evaluationState({
      evaluationId: row.id,
      state: row.state,
      pausedAt: row.pausedAt,
      closesAt: row.closesAt,
      now: app.clock.now(),
    });
    // Students hold `classroom:<id>` on every connection, which is what
    // `resultsChanged` addresses; no per-user topic is needed.
    gradingEvents.resultsChanged(row, []);
  }
}
