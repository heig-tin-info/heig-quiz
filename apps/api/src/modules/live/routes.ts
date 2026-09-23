/**
 * HTTP surface of the `live` module (PLAN-MVP §4.4).
 *
 * Two audiences, two halves:
 *   - the STUDENT routes (`/attempts/:id/…`) are the ones that must be fast
 *     and unambiguous under a deadline: every one of them carries `serverNow`
 *     back, and every write goes through the gate of §4.7;
 *   - the TEACHER routes (`/evaluations/:id/…`) are the operational
 *     transitions of §5.1, each audited (F-LIVE-11) and each propagated as a
 *     typed SSE event.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AttemptEventBody,
  AttemptParam,
  AnswerParam,
  AttemptStartBody,
  AutosaveRequest,
  DashboardQuery,
  ExtendBody,
  IdParam,
  MarkDoneBody,
  PositionBody,
  RunBody,
  SimulateBody,
  StartBody,
  SubmitBody,
  type ExtendResponse,
  type ResetAttemptResponse,
  type RunAccepted,
  type SubmitResponse,
} from "@quiz/contracts";

import { tracer, type AuditAction } from "../../audit.js";
import { iso } from "../../clock.js";
import {
  loadEvaluation,
  ownAttempt,
  reachableEvaluation,
  staffAttempt,
  teacherGuard,
} from "../guards.js";
import { notFound, studentRoute, teacherRoute } from "../http.js";
import * as evaluationService from "../evaluation/service.js";
import { presence } from "../realtime/presence.js";
import * as events from "./events.js";
import * as service from "./service.js";

/** Rate limit of the journal route (F-EVAL-13): 60 entries a minute. */
const EVENTS_PER_MINUTE = 60;

export async function livePlugin(app: FastifyInstance) {
  const requireSession = (req: FastifyRequest, reply: FastifyReply) =>
    app.requireSession(req, reply);
  const requireTeacher = teacherGuard(app);

  /** Maps every failure of the module to its status, `410` bodies included. */
  function failure(reply: FastifyReply, error: unknown, now: Date): FastifyReply {
    if (error instanceof service.AttemptClosedError) {
      return reply.code(410).send(error.body(now));
    }
    if (error instanceof service.AnswerInvalid) {
      return reply.code(422).send({ error: error.code, details: error.details });
    }
    if (error instanceof service.RateLimited) {
      return reply
        .header("retry-after", String(error.retryAfterS))
        .code(429)
        .send({ error: error.code });
    }
    if (error instanceof service.RunnerDown) {
      // `reason` beside `message`: the player names the failure with it
      // ("busy", "not_configured", "timeout") without parsing a sentence.
      return reply
        .code(error.status)
        .send({ error: error.code, reason: error.reason, message: error.message });
    }
    if (error instanceof service.LiveError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof evaluationService.EvaluationError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "live route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const trace = tracer(app);
  const student = studentRoute(app, failure);
  const teacher = teacherRoute(app, failure);

  // The loaders of invariant 6, each answering its own 404.
  const own = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    ownAttempt(app, req, reply, p.id);
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const staffEvaluationAttempt = async (
    req: FastifyRequest,
    reply: FastifyReply,
    p: { id: string; attemptId: string },
  ) => {
    const scope = await loadEvaluation(app, req, reply, p.id);
    if (!scope) return null;
    const attempt = await staffAttempt(app, req, reply, p.id, p.attemptId);
    return attempt && { evaluation: scope.evaluation, attempt };
  };

  // =========================================================================
  // Student side
  // =========================================================================

  app.get("/app/api/student/home", { preHandler: requireSession }, async (req) =>
    service.studentHome(app.db, req.user!.id, app.clock.now()),
  );

  /** F-LIVE-01. Idempotent: the same student always lands on the same attempt. */
  app.post(
    "/app/api/evaluations/:id/attempt",
    { preHandler: requireSession },
    student(
      {
        params: IdParam,
        body: AttemptStartBody,
        optionalBody: true,
        load: (req, reply, p) => reachableEvaluation(app, req, reply, p.id),
      },
      async ({ req, reply, now, body, scope }) => {
        const participant = await service.participantOf(app.db, scope.evaluation, req.user!.id);
        // A CLAIMED roster seat is the whole admission, staff or not: a teacher
        // who joined their own classroom walks the real flow (ADR-018), and a
        // teacher who did not holds no seat and gets the 404 a stranger gets.
        if (!participant) return notFound(reply);
        const result = await service.enterEvaluation(app.db, {
          evaluation: scope.evaluation,
          participant,
          accessCode: body.accessCode,
          ip: req.ip,
          now,
        });
        events.lobbyChanged(
          scope.evaluation.id,
          presence.count(scope.evaluation.id),
          await service.enrolledCount(app.db, scope.evaluation),
        );
        return result.kind === "lobby"
          ? { kind: "lobby", view: result.view }
          : { kind: "attempt", view: result.view };
      },
    ),
  );

  /**
   * ADR-018: a teacher throws away their OWN staff test attempt.
   *
   * `POST /evaluations/:id/attempt` is idempotent per participant, so
   * without this a teacher tests a quiz exactly once and then has no way
   * back into the flow. Three things make it safe, and the service loads all
   * three rather than checking them afterwards (invariant 6): the caller is
   * staff of the course (the guard), the seat they hold in the classroom is
   * a STAFF seat, and the attempt deleted is keyed on their own user id. A
   * student's attempt is therefore unreachable from here, at any state, and
   * the `410 attempt_closed` gate does not apply: this is not a write into
   * somebody's exam, it is a teacher erasing their own rehearsal.
   */
  app.delete(
    "/app/api/evaluations/:id/attempt",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ req, scope }) => {
      const result = await service.resetOwnStaffAttempt(app.db, scope.evaluation, req.user!.id);
      if (result.deleted) {
        await trace(req, "attempt.staff_reset", "evaluation", scope.evaluation.id, {
          attemptId: result.attemptId,
        });
      }
      return { deleted: result.deleted } satisfies ResetAttemptResponse;
    }),
  );

  /**
   * F-LIVE-06: the whole state back, answers and position included — but
   * only once the evaluation has started. Before that it answers the LOBBY,
   * exactly as `POST /evaluations/:id/attempt` does: an attempt id is not a
   * key to the questions (see `attemptOrLobbyView`).
   */
  app.get(
    "/app/api/attempts/:id",
    { preHandler: requireSession },
    student({ params: IdParam, load: own }, async ({ now, scope }) => {
      // A sign of life only counts while the attempt is live: a submitted
      // student refreshing this page must not show up as online on the grid.
      if (service.isOpen(scope.evaluation, scope.attempt, now)) {
        await service.markPresent(app.db, scope.attempt.id, now);
      }
      return service.attemptOrLobbyView(app.db, scope.evaluation, scope.attempt, now);
    }),
  );

  /** §4.7 — the autosave. One statement, three 410 reasons, always `serverNow`. */
  app.put(
    "/app/api/attempts/:id/answers/:itemId",
    { preHandler: requireSession },
    student({ params: AnswerParam, body: AutosaveRequest, load: own }, ({ now, params, body, scope }) =>
      service.saveAnswer(app.db, {
        evaluation: scope.evaluation,
        attempt: scope.attempt,
        itemId: params.itemId,
        payload: body.payload,
        revision: body.revision,
        now,
      }),
    ),
  );

  /** F-LIVE-08. */
  app.post(
    "/app/api/attempts/:id/answers/:itemId/done",
    { preHandler: requireSession },
    student(
      { params: AnswerParam, body: MarkDoneBody, load: own },
      async ({ now, params, body, scope }) => {
        const result = await service.markDone(app.db, {
          evaluation: scope.evaluation,
          attempt: scope.attempt,
          itemId: params.itemId,
          done: body.done,
          now,
        });
        return { ...result, serverNow: iso(now) };
      },
    ),
  );

  app.post(
    "/app/api/attempts/:id/position",
    { preHandler: requireSession },
    student({ params: IdParam, body: PositionBody, load: own }, async ({ reply, now, body, scope }) => {
      service.assertOpen(scope.evaluation, scope.attempt, now);
      await service.setPosition(app.db, scope.attempt, body.itemId, now);
      return reply.code(204).send();
    }),
  );

  /** F-LIVE-10. */
  app.post(
    "/app/api/attempts/:id/submit",
    { preHandler: requireSession },
    student({ params: IdParam, body: SubmitBody, load: own }, async ({ now, scope }) => {
      const row = await service.submitAttempt(app.db, scope.evaluation, scope.attempt, now);
      return {
        state: row.state,
        submittedAt: iso(row.submittedAt ?? now),
        serverNow: iso(now),
      } satisfies SubmitResponse;
    }),
  );

  /** F-EVAL-13: the journal. Bounded, never blocking, never a 4xx storm. */
  app.post(
    "/app/api/attempts/:id/events",
    { preHandler: requireSession },
    student(
      { params: IdParam, body: AttemptEventBody, load: own },
      async ({ reply, now, body, scope }) => {
        // The journal follows the attempt: once it is over, it stops growing.
        service.assertOpen(scope.evaluation, scope.attempt, now);
        const used = await service.countRecentEvents(
          app.db,
          scope.attempt.id,
          body.kind,
          new Date(now.getTime() - 60_000),
        );
        if (used >= EVENTS_PER_MINUTE) {
          return reply.header("retry-after", "60").code(429).send({ error: "rate_limited" });
        }
        await service.logAttemptEvent(app.db, scope.attempt.id, body.kind, body.details ?? null, now);
        // A reconnection is also a sign of life for the dashboard.
        if (body.kind === "reconnect") await service.markPresent(app.db, scope.attempt.id, now);
        return reply.code(204).send();
      },
    ),
  );

  /**
   * The student's Run button. With `RUNNER_MODE=stub` — every development
   * machine and CI runner — this answers `503 runner_unavailable`, which is a
   * configuration and not a failure (decision D14).
   */
  app.post(
    "/app/api/attempts/:id/run",
    { preHandler: requireSession },
    student({ params: IdParam, body: RunBody, load: own }, async ({ reply, now, body, scope }) => {
      const outcome = await service.runVisibleCases(app.db, {
        runner: app.runner,
        evaluation: scope.evaluation,
        attempt: scope.attempt,
        itemId: body.itemId,
        regions: body.regions,
        stdin: body.stdin,
        args: body.args,
        now,
      });
      // 202: the authoritative delivery is the `runner.result` SSE frame; the
      // body repeats it so a client without a stream still works. A FRESH
      // literal, not `outcome` itself: only a literal gets the excess-property
      // check, so a field added to the service's return type cannot leak onto
      // the wire without this line being edited too.
      return reply
        .code(202)
        .send({ requestId: outcome.requestId, result: outcome.result } satisfies RunAccepted);
    }),
  );

  /**
   * The student's Simulate button (ADR-019). Generic: any question type that
   * implements `interactiveRequest` gets this route, and the outcome comes
   * back raw for the client half of that type to read.
   *
   * `200` and not `202`: there is no SSE frame behind it, so the response is
   * the delivery. With `RUNNER_MODE=stub` it answers `503
   * runner_unavailable`, which is a configuration and not a failure
   * (decision D14).
   */
  app.post(
    "/app/api/attempts/:id/simulate",
    { preHandler: requireSession },
    student({ params: IdParam, body: SimulateBody, load: own }, async ({ reply, now, body, scope }) => {
      const outcome = await service.simulateAnswer(app.db, {
        runner: app.runner,
        evaluation: scope.evaluation,
        attempt: scope.attempt,
        itemId: body.itemId,
        answer: body.answer,
        now,
      });
      return reply.code(200).send(outcome);
    }),
  );

  // =========================================================================
  // Teacher side
  // =========================================================================

  app.get(
    "/app/api/evaluations/:id/dashboard",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, query: DashboardQuery, load: staffEvaluation }, ({ now, query, scope }) =>
      service.dashboardView(app.db, scope.evaluation, {
        now,
        includeAnswers: query.includeAnswers,
        includeResults: query.results,
      }),
    ),
  );

  /** One transition per route, so the audit log reads like the event it is. */
  function control(
    path: string,
    action: AuditAction,
    move: (
      evaluation: evaluationService.EvaluationRecord,
      now: Date,
    ) => Promise<evaluationService.EvaluationRecord>,
    to: "running" | "paused" | "closed",
  ) {
    app.post(
      `/app/api/evaluations/:id/${path}`,
      { preHandler: requireTeacher },
      teacher(
        {
          params: IdParam,
          // Only `start` has a body, and it is validated, not read.
          ...(path === "start" ? { body: StartBody, optionalBody: true } : {}),
          load: staffEvaluation,
        },
        async ({ req, now, scope }) => {
          // The legality of the move is the evaluation module's table; the
          // side effects on the attempts are this module's.
          evaluationService.guardTransition(scope.evaluation, to, {
            itemCount: (await evaluationService.itemRows(app.db, scope.evaluation.id)).length,
            attemptCount: await evaluationService.attemptCount(app.db, scope.evaluation.id),
          });
          const row = await move(scope.evaluation, now);
          await trace(req, action, "evaluation", row.id, { from: scope.evaluation.state, to });
          return evaluationService.toEvaluation(row);
        },
      ),
    );
  }

  control("start", "evaluation.start", (e, now) => service.startEvaluation(app.db, e, now), "running");
  control("pause", "evaluation.pause", (e, now) => service.pauseEvaluation(app.db, e, now), "paused");
  control("resume", "evaluation.resume", (e, now) => service.resumeEvaluation(app.db, e, now), "running");
  control("close", "evaluation.close", (e, now) => service.closeEvaluation(app.db, e, now, "teacher", app), "closed");

  /** F-LIVE-11/12. */
  app.post(
    "/app/api/evaluations/:id/extend",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ExtendBody, load: staffEvaluation },
      async ({ req, reply, now, body, scope }) => {
        if (body.scope === "attempt") {
          const target = await staffAttempt(app, req, reply, scope.evaluation.id, body.attemptId!);
          if (!target) return reply;
        }
        const updated = await service.extendTime(
          app.db,
          scope.evaluation,
          {
            minutes: body.minutes,
            attemptId: body.scope === "attempt" ? body.attemptId : undefined,
          },
          now,
        );
        await trace(req, "evaluation.extend", "evaluation", scope.evaluation.id, {
          minutes: body.minutes,
          scope: body.scope,
          attemptId: body.attemptId ?? null,
          updated,
        });
        return { updated, serverNow: iso(now) } satisfies ExtendResponse;
      },
    ),
  );

  /** F-DASH-05. */
  app.get(
    "/app/api/evaluations/:id/attempts/:attemptId",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, ({ now, scope }) =>
      service.attemptInspect(app.db, scope.evaluation, scope.attempt, now),
    ),
  );

  /** Closing ONE student (F-LIVE-11) — the grid keeps running for everybody else. */
  app.post(
    "/app/api/evaluations/:id/attempts/:attemptId/close",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, now, scope }) => {
      const row = await service.closeAttempt(app.db, scope.evaluation, scope.attempt, now);
      await trace(req, "attempt.close", "attempt", row.id, { evaluationId: scope.evaluation.id });
      return { state: row.state, serverNow: iso(now) };
    }),
  );

  /** …and giving it back, with the deadline recomputed from the original start. */
  app.post(
    "/app/api/evaluations/:id/attempts/:attemptId/reopen",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, now, scope }) => {
      const row = await service.reopenAttempt(app.db, scope.evaluation, scope.attempt, now);
      await trace(req, "attempt.reopen", "attempt", row.id, { evaluationId: scope.evaluation.id });
      return {
        state: row.state,
        deadlineAt: row.deadlineAt === null ? null : iso(row.deadlineAt),
        serverNow: iso(now),
      };
    }),
  );
}
