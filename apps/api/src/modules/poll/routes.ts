/**
 * HTTP surface of the `poll` module (F-LIVE-13, F-LIVE-14, F-AUTH-05,
 * ADR-014). Two audiences, and they do not overlap:
 *
 *   - the TEACHER half (`/app/api/polls…`, `/app/api/evaluations/:id/poll…`)
 *     is an ordinary teacher surface: `requireTeacher`, then the entity is
 *     LOADED through the staff predicate and an unreachable one is a 404
 *     (invariant 6);
 *   - the PUBLIC half (`/app/api/p/:code…`) is the only unauthenticated
 *     write surface of the platform. It is safe because of what it can
 *     reach, not because of who is behind it:
 *       * a caller must hold a six-character code that only exists while a
 *         poll runs, and the answer it can write is an answer to THAT poll's
 *         single question — nothing else in the platform is addressable;
 *       * the `quiz_guest` cookie is scoped to `/app/api/p`, is `HttpOnly`,
 *         carries no identity and is worth exactly one vote in one poll;
 *       * the ordinary double-submit CSRF check of `requireSession` does not
 *         apply (there is no session to protect), but when a `quiz_csrf`
 *         cookie IS present — a signed-in teacher or student trying the
 *         poll from their own browser — the header must match it, so a
 *         cross-site form cannot make THEM vote;
 *       * the read never carries the key before the teacher revealed it, and
 *         the question content goes through `studentView` like every other
 *         student payload (invariant 4).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  IdParam,
  PollAnswer,
  PollCodeParam,
  PollCreate,
  PollQuestionCreate,
  PollRevealBody,
  type PollTeacherView,
} from "@quiz/contracts";

import { audit, type AuditAction } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/session.js";
import { classrooms, courses, pools, questions } from "../../db/schema.js";
import { staffAccess, poolAccess, teacherGuard } from "../guards.js";
import { byId } from "../evaluation/service.js";
import * as live from "../live/service.js";
import * as poolService from "../pool/service.js";
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

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "not_found" });
}

export async function pollPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const secure = config.NODE_ENV === "production";

  const trace = (req: FastifyRequest, action: AuditAction, id: string, payload?: unknown) =>
    audit(app.db, {
      actorUserId: req.user?.id ?? null,
      actorType: "user",
      action,
      subjectType: "evaluation",
      subjectId: id,
      ...(payload === undefined ? {} : { payload }),
    });

  function failure(reply: FastifyReply, error: unknown, now: Date): FastifyReply {
    if (error instanceof live.AttemptClosedError) return reply.code(410).send(error.body(now));
    if (error instanceof live.AnswerInvalid) {
      return reply.code(422).send({ error: error.code, details: error.details });
    }
    if (error instanceof service.PollError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof live.LiveError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    app.log.error({ err: error }, "poll route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  // =========================================================================
  // Teacher side
  // =========================================================================

  /** The classroom, loaded through the staff predicate — 404 otherwise. */
  async function reachableClassroom(req: FastifyRequest, classroomId: string) {
    const [row] = await app.db
      .select({ room: classrooms })
      .from(classrooms)
      .innerJoin(courses, eq(classrooms.courseId, courses.id))
      .where(
        and(
          eq(classrooms.id, classroomId),
          req.user!.role === "admin" ? undefined : staffAccess(req.user!.id),
        ),
      )
      .limit(1);
    return row?.room ?? null;
  }

  /** The question, loaded through the pool predicate — 404 otherwise. */
  async function reachableQuestion(req: FastifyRequest, questionId: string) {
    const [row] = await app.db
      .select({ question: questions })
      .from(questions)
      .innerJoin(pools, eq(questions.poolId, pools.id))
      .where(
        and(
          eq(questions.id, questionId),
          req.user!.role === "admin" ? undefined : poolAccess(req.user!.id),
        ),
      )
      .limit(1);
    return row?.question ?? null;
  }

  /** The poll, loaded through the staff predicate of its classroom. */
  async function reachablePoll(req: FastifyRequest, evaluationId: string) {
    const evaluation = await service.pollById(app.db, evaluationId);
    if (!evaluation) return null;
    const room = await reachableClassroom(req, evaluation.classroomId);
    if (!room) return null;
    return service.scopeOf(app.db, evaluation);
  }

  const view = (scope: service.PollScope): Promise<PollTeacherView> =>
    service.teacherView(app.db, scope, config.WEB_URL);

  /** The teacher's own polls, newest first: the launcher's "run again". */
  app.get("/app/api/polls", { preHandler: requireTeacher }, async (req) =>
    service.listPolls(app.db, req.user!.id),
  );

  /**
   * The pollable questions of the teacher's personal pool. A teacher who has
   * never run a poll has no personal pool yet, and gets an empty list: a
   * READ never creates one.
   */
  app.get("/app/api/polls/questions", { preHandler: requireTeacher }, async (req) => {
    const [pool] = await app.db
      .select({ id: pools.id })
      .from(pools)
      .where(and(eq(pools.ownerId, req.user!.id), eq(pools.isPersonal, true)))
      .limit(1);
    if (!pool) return [];
    return service.questionPicks(app.db, pool.id);
  });

  /**
   * A new poll question, in the teacher's personal pool — which this route
   * creates on first use. The launcher never learns that pool's id: the
   * personal pool stays an implementation detail of the poll flow, and the
   * answer is the same `QuestionDetail` as `POST /pools/:id/questions`.
   */
  app.post("/app/api/polls/questions", { preHandler: requireTeacher }, async (req, reply) => {
    const body = PollQuestionCreate.safeParse(emptyBody(req.body));
    if (!body.success) {
      // A type outside `mcq | short` is not a malformed request, it is a
      // question a poll cannot run: same `422 poll_type` as `POST /polls`.
      if (body.error.issues.some((i) => i.path[0] === "type")) {
        const refused = new service.PollTypeRefused(
          String((emptyBody(req.body) as { type?: unknown }).type),
        );
        return reply.code(422).send({ error: refused.code, message: refused.message });
      }
      return invalid(reply, body.error);
    }
    const pool = await poolService.ensurePersonalPool(app.db, req.user!.id);
    try {
      const id = await poolService.createQuestion(app.db, {
        poolId: pool.id,
        type: body.data.type,
        internalName: body.data.internalName,
        createdBy: req.user!.id,
      });
      const [created] = await app.db.select().from(questions).where(eq(questions.id, id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "question.create",
        subjectType: "question",
        subjectId: id,
        payload: { poolId: pool.id, type: body.data.type, internalName: body.data.internalName },
      });
      return reply.code(201).send(await poolService.questionDetail(app.db, created!));
    } catch {
      return reply
        .code(409)
        .send({ error: "duplicate_name", message: "This pool already has a question by that name" });
    }
  });

  /** F-LIVE-13: create AND start, in one call. */
  app.post("/app/api/polls", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const body = PollCreate.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const room = await reachableClassroom(req, body.data.classroomId);
    if (!room) return notFound(reply);
    const question = await reachableQuestion(req, body.data.questionId);
    if (!question) return notFound(reply);
    try {
      const scope = await service.createPoll(app.db, {
        classroomId: room.id,
        questionId: question.id,
        anonymous: body.data.anonymous,
        createdBy: req.user!.id,
        now,
      });
      await trace(req, "poll.create", scope.evaluation.id, {
        questionId: question.id,
        anonymous: body.data.anonymous,
        code: scope.evaluation.accessCode,
      });
      return reply.code(201).send(await view(scope));
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  app.get("/app/api/evaluations/:id/poll", { preHandler: requireTeacher }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const scope = await reachablePoll(req, params.data.id);
    if (!scope) return notFound(reply);
    return view(scope);
  });

  app.post(
    "/app/api/evaluations/:id/poll/reveal",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = IdParam.safeParse(req.params);
      if (!params.success) return notFound(reply);
      const body = PollRevealBody.safeParse(emptyBody(req.body));
      if (!body.success) return invalid(reply, body.error);
      const scope = await reachablePoll(req, params.data.id);
      if (!scope) return notFound(reply);
      const updated = await service.setRevealed(
        app.db,
        scope.evaluation,
        body.data.revealed,
        now,
      );
      await trace(req, "poll.reveal", updated.id, { revealed: body.data.revealed });
      return view({ ...scope, evaluation: updated });
    },
  );

  /** The end of a poll: closed and graded, never released (ADR-014). */
  app.post(
    "/app/api/evaluations/:id/poll/end",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = IdParam.safeParse(req.params);
      if (!params.success) return notFound(reply);
      const scope = await reachablePoll(req, params.data.id);
      if (!scope) return notFound(reply);
      try {
        const closed = await service.endPoll(app, scope.evaluation, now);
        await trace(req, "poll.end", closed.id);
        return await view({ ...scope, evaluation: closed });
      } catch (error) {
        return failure(reply, error, now);
      }
    },
  );

  /** "Run the same question again": a NEW poll, a new code, a clean tally. */
  app.post(
    "/app/api/evaluations/:id/poll/again",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const now = app.clock.now();
      const params = IdParam.safeParse(req.params);
      if (!params.success) return notFound(reply);
      const scope = await reachablePoll(req, params.data.id);
      if (!scope) return notFound(reply);
      try {
        const again = await service.createPoll(app.db, {
          classroomId: scope.evaluation.classroomId,
          questionId: scope.item.question.id,
          anonymous: service.pollSettingsOf(scope.evaluation).anonymous,
          createdBy: req.user!.id,
          now,
        });
        await trace(req, "poll.create", again.evaluation.id, {
          questionId: scope.item.question.id,
          again: scope.evaluation.id,
          code: again.evaluation.accessCode,
        });
        return reply.code(201).send(await view(again));
      } catch (error) {
        return failure(reply, error, now);
      }
    },
  );

  // =========================================================================
  // Public side — no session, no roster (F-AUTH-05)
  // =========================================================================

  /**
   * The double-submit check, for a route that has no session to require. A
   * browser that holds a `quiz_csrf` cookie is signed in somewhere on this
   * origin, and a cross-site POST must not be able to spend that session's
   * vote; a browser with no such cookie has nothing to steal and is let
   * through, which is exactly the phone of an anonymous participant.
   */
  function csrfRefused(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
    const cookie = req.cookies[CSRF_COOKIE];
    if (!cookie) return null;
    if (cookie === req.headers[CSRF_HEADER]) return null;
    return reply.code(403).send({ error: "csrf" });
  }

  /** The poll a code names, with the browser's identity resolved. */
  async function publicScope(
    req: FastifyRequest,
    code: string,
    now: Date,
  ): Promise<{
    scope: service.PollScope;
    state: "running" | "ended";
    viewer: service.Viewer & { loggedIn: boolean };
  } | null> {
    const found = await service.byCode(app.db, code, now);
    if (!found) return null;
    const scope = await service.scopeOf(app.db, found.evaluation);
    if (!scope) return null;
    const token = req.cookies[service.GUEST_COOKIE];
    const guest =
      req.user || !token ? null : await service.guestByToken(app.db, found.evaluation.id, token);
    return {
      scope,
      state: found.state,
      viewer: {
        userId: req.user?.id ?? null,
        guestId: guest?.id ?? null,
        loggedIn: Boolean(req.user),
      },
    };
  }

  app.get("/app/api/p/:code", async (req, reply) => {
    const now = app.clock.now();
    const params = PollCodeParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const found = await publicScope(req, params.data.code, now);
    if (!found) return notFound(reply);
    return service.publicView(app.db, found.scope, found.state, found.viewer);
  });

  /**
   * Joining. A session joins as itself; a browser with no session joins as a
   * guest when the poll is anonymous, and is told to sign in otherwise.
   */
  app.post("/app/api/p/:code/join", async (req, reply) => {
    const now = app.clock.now();
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    const params = PollCodeParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const found = await publicScope(req, params.data.code, now);
    if (!found) return notFound(reply);
    const { scope, viewer } = found;
    if (found.state !== "running") {
      // Nothing to join any more; the page still shows the question.
      return service.publicView(app.db, scope, found.state, viewer);
    }
    const settings = service.pollSettingsOf(scope.evaluation);
    if (!viewer.loggedIn && !settings.anonymous) {
      return reply.code(401).send({
        error: "login_required",
        message: "This poll asks who answers",
        next: `/p/${scope.evaluation.accessCode}`,
      });
    }
    try {
      if (viewer.loggedIn) {
        await service.join(app.db, scope.evaluation, { userId: viewer.userId, guestId: null }, now);
      } else {
        // The cookie IS the identity: minted here, once per browser, and
        // never readable by a script.
        const token = req.cookies[service.GUEST_COOKIE] ?? service.newGuestToken();
        const guest = await service.ensureGuest(app.db, scope.evaluation.id, token, now);
        reply.setCookie(service.GUEST_COOKIE, token, {
          path: service.GUEST_COOKIE_PATH,
          httpOnly: true,
          sameSite: "lax",
          secure,
          maxAge: service.GUEST_TTL_S,
        });
        viewer.guestId = guest.id;
        await service.join(app.db, scope.evaluation, { userId: null, guestId: guest.id }, now);
      }
      return await service.publicView(app.db, scope, found.state, viewer);
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  /** One answer, changeable until the poll ends. */
  app.post("/app/api/p/:code/answer", async (req, reply) => {
    const now = app.clock.now();
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    const params = PollCodeParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = PollAnswer.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const found = await publicScope(req, params.data.code, now);
    if (!found) return notFound(reply);
    const { scope, viewer } = found;
    if (found.state !== "running") {
      return reply.code(410).send({ error: "attempt_closed", reason: "evaluation_closed" });
    }
    const attempt = await service.attemptOfViewer(app.db, scope.evaluation, viewer);
    if (!attempt) return reply.code(403).send({ error: "not_joined" });
    try {
      await service.answerPoll(app.db, scope, attempt, body.data.payload, now);
      return await service.publicView(app.db, scope, found.state, viewer);
    } catch (error) {
      return failure(reply, error, now);
    }
  });
}
