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
import { z } from "zod";

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
  StartBody,
  SubmitBody,
} from "@quiz/contracts";

import { audit, type AuditAction } from "../../audit.js";
import { iso } from "../../clock.js";
import {
  accessibleEvaluation,
  loadEvaluation,
  ownAttempt,
  reachableEvaluation,
  staffAttempt,
  teacherGuard,
} from "../guards.js";
import * as evaluationService from "../evaluation/service.js";
import { presence } from "../realtime/presence.js";
import * as events from "./events.js";
import * as service from "./service.js";

const emptyBody = (body: unknown) => (body === undefined || body === null ? {} : body);

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "validation",
    details: error.issues.map((i) => ({
      path: i.path.map(String),
      code: i.code,
      message: i.message,
    })),
  });
}

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
    if (error instanceof service.LiveError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof evaluationService.EvaluationError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    app.log.error({ err: error }, "live route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const trace = (
    req: FastifyRequest,
    action: AuditAction,
    subjectType: string,
    id: string,
    payload?: unknown,
  ) =>
    audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action,
      subjectType,
      subjectId: id,
      ...(payload === undefined ? {} : { payload }),
    });

  // =========================================================================
  // Student side
  // =========================================================================

  app.get("/app/api/student/home", { preHandler: requireSession }, async (req) =>
    service.studentHome(app.db, req.user!.id, app.clock.now()),
  );

  /** F-LIVE-01. Idempotent: the same student always lands on the same attempt. */
  app.post("/app/api/evaluations/:id/attempt", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = AttemptStartBody.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const scope = await reachableEvaluation(app, req, reply, params.data.id);
    if (!scope) return reply;
    const participant = await service.participantOf(app.db, scope.evaluation, req.user!.id);
    // A staff member has no roster seat: they preview, they do not take part.
    if (!participant) return reply.code(404).send({ error: "not_found" });
    try {
      const result = await service.enterEvaluation(app.db, {
        evaluation: scope.evaluation,
        participant,
        accessCode: body.data.accessCode,
        ip: req.ip,
        now,
      });
      events.lobbyChanged(
        scope.evaluation.id,
        presence.count(scope.evaluation.id),
        await service.enrolledCount(app.db, scope.evaluation.classroomId),
      );
      return result.kind === "lobby"
        ? { kind: "lobby", view: result.view }
        : { kind: "attempt", view: result.view };
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  /** F-LIVE-06: the whole state back, answers and position included. */
  app.get("/app/api/attempts/:id", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const scope = await ownAttempt(app, req, reply, params.data.id);
    if (!scope) return reply;
    await service.markPresent(app.db, scope.attempt.id, now);
    return service.attemptView(app.db, scope.evaluation, scope.attempt, now);
  });

  /** §4.7 — the autosave. One statement, three 410 reasons, always `serverNow`. */
  app.put(
    "/app/api/attempts/:id/answers/:itemId",
    { preHandler: requireSession },
    async (req, reply) => {
      const now = app.clock.now();
      const params = AnswerParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = AutosaveRequest.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const scope = await ownAttempt(app, req, reply, params.data.id);
      if (!scope) return reply;
      try {
        return await service.saveAnswer(app.db, {
          evaluation: scope.evaluation,
          attempt: scope.attempt,
          itemId: params.data.itemId,
          payload: body.data.payload,
          revision: body.data.revision,
          now,
        });
      } catch (error) {
        return failure(reply, error, now);
      }
    },
  );

  /** F-LIVE-08. */
  app.post(
    "/app/api/attempts/:id/answers/:itemId/done",
    { preHandler: requireSession },
    async (req, reply) => {
      const now = app.clock.now();
      const params = AnswerParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const body = MarkDoneBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const scope = await ownAttempt(app, req, reply, params.data.id);
      if (!scope) return reply;
      try {
        const result = await service.markDone(app.db, {
          evaluation: scope.evaluation,
          attempt: scope.attempt,
          itemId: params.data.itemId,
          done: body.data.done,
          now,
        });
        return { ...result, serverNow: iso(now) };
      } catch (error) {
        return failure(reply, error, now);
      }
    },
  );

  app.post("/app/api/attempts/:id/position", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = PositionBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const scope = await ownAttempt(app, req, reply, params.data.id);
    if (!scope) return reply;
    await service.setPosition(app.db, scope.attempt, body.data.itemId, now);
    return reply.code(204).send();
  });

  /** F-LIVE-10. */
  app.post("/app/api/attempts/:id/submit", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = SubmitBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const scope = await ownAttempt(app, req, reply, params.data.id);
    if (!scope) return reply;
    try {
      const row = await service.submitAttempt(app.db, scope.evaluation, scope.attempt, now);
      return { state: row.state, submittedAt: iso(row.submittedAt ?? now), serverNow: iso(now) };
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  /** F-EVAL-13: the journal. Bounded, never blocking, never a 4xx storm. */
  app.post("/app/api/attempts/:id/events", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = AttemptEventBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const scope = await ownAttempt(app, req, reply, params.data.id);
    if (!scope) return reply;
    const used = await service.countRecentEvents(
      app.db,
      scope.attempt.id,
      body.data.kind,
      new Date(now.getTime() - 60_000),
    );
    if (used >= EVENTS_PER_MINUTE) {
      return reply.header("retry-after", "60").code(429).send({ error: "rate_limited" });
    }
    await service.logAttemptEvent(
      app.db,
      scope.attempt.id,
      body.data.kind,
      body.data.details ?? null,
      now,
    );
    // A reconnection is also a sign of life for the dashboard.
    if (body.data.kind === "reconnect") await service.markPresent(app.db, scope.attempt.id, now);
    return reply.code(204).send();
  });

  /**
   * The student's Run button. With `RUNNER_MODE=stub` — every development
   * machine and CI runner — this answers `503 runner_unavailable`, which is a
   * configuration and not a failure (decision D14).
   */
  app.post("/app/api/attempts/:id/run", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = RunBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const scope = await ownAttempt(app, req, reply, params.data.id);
    if (!scope) return reply;
    try {
      const outcome = await service.runVisibleCases(app.db, {
        runner: app.runner,
        evaluation: scope.evaluation,
        attempt: scope.attempt,
        itemId: body.data.itemId,
        regions: body.data.regions,
        stdin: body.data.stdin,
        now,
      });
      // 202: the authoritative delivery is the `runner.result` SSE frame; the
      // body repeats it so a client without a stream still works.
      return reply.code(202).send(outcome);
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  // =========================================================================
  // Teacher side
  // =========================================================================

  app.get(
    "/app/api/evaluations/:id/dashboard",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      const query = DashboardQuery.safeParse(req.query ?? {});
      if (!query.success) return invalid(reply, query.error);
      return service.dashboardView(app.db, scope.evaluation, {
        now: app.clock.now(),
        includeAnswers: query.data.includeAnswers,
      });
    },
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
    app.post(`/app/api/evaluations/:id/${path}`, { preHandler: requireTeacher }, async (req, reply) => {
      const now = app.clock.now();
      const scope = await accessibleEvaluation(app, req, reply);
      if (!scope) return reply;
      if (path === "start") {
        const body = StartBody.safeParse(emptyBody(req.body));
        if (!body.success) return invalid(reply, body.error);
      }
      try {
        // The legality of the move is the evaluation module's table; the
        // side effects on the attempts are this module's.
        evaluationService.guardTransition(scope.evaluation, to, {
          itemCount: (await evaluationService.itemRows(app.db, scope.evaluation.id)).length,
          attemptCount: await evaluationService.attemptCount(app.db, scope.evaluation.id),
        });
        const row = await move(scope.evaluation, now);
        await trace(req, action, "evaluation", row.id, { from: scope.evaluation.state, to });
        return evaluationService.toEvaluation(row);
      } catch (error) {
        return failure(reply, error, now);
      }
    });
  }

  control("start", "evaluation.start", (e, now) => service.startEvaluation(app.db, e, now), "running");
  control("pause", "evaluation.pause", (e, now) => service.pauseEvaluation(app.db, e, now), "paused");
  control("resume", "evaluation.resume", (e, now) => service.resumeEvaluation(app.db, e, now), "running");
  control("close", "evaluation.close", (e, now) => service.closeEvaluation(app.db, e, now, "teacher", app), "closed");

  /** F-LIVE-11/12. */
  app.post("/app/api/evaluations/:id/extend", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const scope = await accessibleEvaluation(app, req, reply);
    if (!scope) return reply;
    const body = ExtendBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    if (body.data.scope === "attempt") {
      const target = await staffAttempt(app, req, reply, scope.evaluation.id, body.data.attemptId!);
      if (!target) return reply;
    }
    const updated = await service.extendTime(
      app.db,
      scope.evaluation,
      {
        minutes: body.data.minutes,
        attemptId: body.data.scope === "attempt" ? body.data.attemptId : undefined,
      },
      now,
    );
    await trace(req, "evaluation.extend", "evaluation", scope.evaluation.id, {
      minutes: body.data.minutes,
      scope: body.data.scope,
      attemptId: body.data.attemptId ?? null,
      updated,
    });
    return { updated, serverNow: iso(now) };
  });

  /** F-DASH-05. */
  app.get(
    "/app/api/evaluations/:id/attempts/:attemptId",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const params = AttemptParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      const attempt = await staffAttempt(
        app,
        req,
        reply,
        params.data.id,
        params.data.attemptId,
      );
      if (!attempt) return reply;
      return service.attemptInspect(app.db, scope.evaluation, attempt, app.clock.now());
    },
  );

  /** Closing ONE student (F-LIVE-11) — the grid keeps running for everybody else. */
  app.post(
    "/app/api/evaluations/:id/attempts/:attemptId/close",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = AttemptParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      const attempt = await staffAttempt(app, req, reply, params.data.id, params.data.attemptId);
      if (!attempt) return reply;
      const row = await service.closeAttempt(app.db, scope.evaluation, attempt, now);
      await trace(req, "attempt.close", "attempt", row.id, { evaluationId: scope.evaluation.id });
      return { state: row.state, serverNow: iso(now) };
    },
  );

  /** …and giving it back, with the deadline recomputed from the original start. */
  app.post(
    "/app/api/evaluations/:id/attempts/:attemptId/reopen",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = AttemptParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const scope = await loadEvaluation(app, req, reply, params.data.id);
      if (!scope) return reply;
      const attempt = await staffAttempt(app, req, reply, params.data.id, params.data.attemptId);
      if (!attempt) return reply;
      const row = await service.reopenAttempt(app.db, scope.evaluation, attempt, now);
      await trace(req, "attempt.reopen", "attempt", row.id, { evaluationId: scope.evaluation.id });
      return {
        state: row.state,
        deadlineAt: row.deadlineAt === null ? null : iso(row.deadlineAt),
        serverNow: iso(now),
      };
    },
  );
}
