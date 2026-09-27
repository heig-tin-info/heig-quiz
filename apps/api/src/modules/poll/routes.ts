/**
 * HTTP surface of the `poll` module (F-LIVE-13, F-LIVE-14, F-AUTH-05,
 * ADR-014). Two audiences, and they do not overlap:
 *
 *   - the TEACHER half (`/app/api/polls…`, `/app/api/evaluations/:id/poll…`)
 *     is an ordinary teacher surface: `requireTeacher`, then the entity is
 *     LOADED through the staff predicate — or, for an anonymous poll that
 *     belongs to no classroom, through its ownership (`findManagedEvaluation`,
 *     ADR-014 addendum 2026-09-27) — and an unreachable one is a 404
 *     (invariant 6);
 *   - the PUBLIC half (`/app/api/p/:code…`) is the only unauthenticated
 *     write surface of the platform. It is safe because of what it can
 *     reach, not because of who is behind it:
 *       * a caller must hold a six-character code that only exists while a
 *         poll runs, and the answer it can write is an answer to THAT poll's
 *         single question — nothing else in the platform is addressable;
 *       * a classroom's poll admits its roster and its staff, signed in, and
 *         nobody else: the viewer is loaded through `findReachableEvaluation`
 *         before anything is read, joined or answered;
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
import { eq } from "drizzle-orm";

import {
  IdParam,
  PollAnswer,
  PollCodeParam,
  PollCreate,
  type PollAudience,
  PollInlineCreate,
  PollPoolSearch,
  PollQuestionCreate,
  PollRevealBody,
  type PollTeacherView,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/session.js";
import { questions } from "../../db/schema.js";
import {
  accessWhere,
  findAccessibleClassroom,
  findAccessibleQuestion,
  findManagedEvaluation,
  findOwnUnsavedPollQuestion,
  findReachableEvaluation,
  poolAccess,
  teacherGuard,
} from "../guards.js";
import { emptyBody, invalid, notFound, teacherRoute } from "../http.js";
import * as live from "../live/service.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

export async function pollPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const secure = config.NODE_ENV === "production";

  const trace = tracer(app);

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
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "poll route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);

  // =========================================================================
  // Teacher side
  // =========================================================================

  /** The classroom, loaded through the staff predicate — 404 otherwise. */
  async function reachableClassroom(req: FastifyRequest, classroomId: string) {
    return (await findAccessibleClassroom(app.db, req.user!, classroomId))?.room ?? null;
  }

  /**
   * The question, loaded through the pool predicate, or — for one written
   * in the launcher and never kept — through the polls the caller launched
   * on it (ADR-014, addendum 2026-09-27). 404 otherwise.
   */
  async function reachableQuestion(req: FastifyRequest, questionId: string) {
    return (
      (await findAccessibleQuestion(app.db, req.user!, questionId))?.question ??
      (await findOwnUnsavedPollQuestion(app.db, req.user!, questionId))
    );
  }

  /**
   * The poll, loaded through the staff predicate of its classroom — or, when
   * it has none, through its ownership (ADR-014, addendum 2026-09-27). A
   * colleague asking for someone else's anonymous poll gets the 404 of a
   * poll that does not exist.
   */
  async function reachablePoll(req: FastifyRequest, evaluationId: string) {
    const evaluation = await findManagedEvaluation(app.db, req.user!, evaluationId);
    if (!evaluation || evaluation.mode !== "poll") return null;
    return service.scopeOf(app.db, evaluation);
  }

  /**
   * Where a new poll lives: nowhere for an anonymous one, the classroom —
   * loaded through the staff predicate, `undefined` when unreachable — for a
   * classroom's.
   */
  async function homeOfAudience(
    req: FastifyRequest,
    audience: PollAudience,
  ): Promise<string | null | undefined> {
    const classroomId = service.audienceClassroom(audience);
    if (classroomId === null) return null;
    return (await reachableClassroom(req, classroomId))?.id;
  }

  /** `reachablePoll` as a loader of invariant 6: it answers its own 404. */
  async function staffPoll(req: FastifyRequest, reply: FastifyReply, p: { id: string }) {
    const scope = await reachablePoll(req, p.id);
    if (scope) return scope;
    await notFound(reply);
    return null;
  }

  /**
   * The teacher's screen, naming the question's pool only when the caller
   * reaches it through the pool predicate (invariant 6): a colleague on the
   * same staff learns the question is saved, not where a private pool is.
   */
  async function view(req: FastifyRequest, scope: service.PollScope): Promise<PollTeacherView> {
    const home =
      scope.item.question.poolId === null
        ? null
        : ((await findAccessibleQuestion(app.db, req.user!, scope.item.question.id))?.pool ?? null);
    return service.teacherView(
      app.db,
      scope,
      config.WEB_URL,
      home ? { id: home.id, name: home.name } : null,
    );
  }

  /** The teacher's own polls, newest first: the launcher's "run again". */
  app.get("/app/api/polls", { preHandler: requireTeacher }, async (req) =>
    service.listPolls(app.db, req.user!.id),
  );

  /**
   * The launcher's "Recent polls" (issue #161): the questions of the polls
   * the caller launched — kept or not — with their outcome, then the
   * never-run questions of their personal pool. A read never creates that
   * pool: a teacher who has never polled gets an empty list.
   */
  app.get("/app/api/polls/questions", { preHandler: requireTeacher }, async (req) =>
    service.questionPicks(app.db, {
      userId: req.user!.id,
      poolWhere: accessWhere(req.user!, poolAccess(req.user!.id)),
    }),
  );

  /**
   * The launcher's "From pools" (issue #162): the pool screen's search over
   * every pool the caller reaches, or — with `classroomId` — over the pools
   * linked to that classroom's course. The classroom is loaded through the
   * staff predicate first, and an unreachable one is a 404 (invariant 6).
   */
  app.get("/app/api/polls/pool-questions", { preHandler: requireTeacher }, async (req, reply) => {
    const query = PollPoolSearch.safeParse(req.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    let courseId: string | null = null;
    if (query.data.classroomId !== undefined) {
      const room = await reachableClassroom(req, query.data.classroomId);
      if (!room) return notFound(reply);
      courseId = room.courseId;
    }
    try {
      return await service.poolQuestionPage(app.db, {
        poolWhere: accessWhere(req.user!, poolAccess(req.user!.id)),
        courseId,
        search: query.data,
      });
    } catch (error) {
      if (error instanceof poolService.InvalidCursor) {
        return reply
          .code(400)
          .send({ error: "invalid_cursor", message: "Restart the list", reason: error.reason });
      }
      throw error;
    }
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
      await trace(req, "question.create", "question", id, {
        poolId: pool.id,
        type: body.data.type,
        internalName: body.data.internalName,
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
    const classroomId = await homeOfAudience(req, body.data.audience);
    if (classroomId === undefined) return notFound(reply);
    const question = await reachableQuestion(req, body.data.questionId);
    if (!question) return notFound(reply);
    try {
      const scope = await service.createPoll(app.db, {
        classroomId,
        questionId: question.id,
        createdBy: req.user!.id,
        now,
      });
      await trace(req, "poll.create", "evaluation", scope.evaluation.id, {
        questionId: question.id,
        audience: body.data.audience.kind,
        classroomId,
        code: scope.evaluation.accessCode,
      });
      return reply.code(201).send(await view(req, scope));
    } catch (error) {
      return failure(reply, error, now);
    }
  });

  /**
   * F-LIVE-13, the quick path: a question written in the launcher, run at
   * once and saved nowhere (ADR-014, addendum 2026-09-23). The audience's
   * classroom is loaded through the staff predicate like `POST /polls`; the content is
   * validated by the type's own schema in the `pool` service.
   */
  app.post("/app/api/polls/inline", { preHandler: requireTeacher }, async (req, reply) => {
    const now = app.clock.now();
    const raw = emptyBody(req.body);
    const body = PollInlineCreate.safeParse(raw);
    if (!body.success) {
      // Same answer as `POST /polls/questions` for a type a poll cannot run.
      if (body.error.issues.some((i) => i.path[0] === "type")) {
        const refused = new service.PollTypeRefused(String((raw as { type?: unknown }).type));
        return reply.code(422).send({ error: refused.code, message: refused.message });
      }
      return invalid(reply, body.error);
    }
    const classroomId = await homeOfAudience(req, body.data.audience);
    if (classroomId === undefined) return notFound(reply);
    try {
      const scope = await service.createInlinePoll(app.db, {
        classroomId,
        type: body.data.type,
        config: body.data.config,
        createdBy: req.user!.id,
        now,
      });
      await trace(req, "poll.create", "evaluation", scope.evaluation.id, {
        questionId: scope.item.question.id,
        inline: true,
        type: body.data.type,
        audience: body.data.audience.kind,
        classroomId,
        code: scope.evaluation.accessCode,
      });
      return reply.code(201).send(await view(req, scope));
    } catch (error) {
      if (error instanceof poolService.DraftInvalid) {
        return reply
          .code(422)
          .send({ error: "config_invalid", message: "The question is incomplete", details: error.issues });
      }
      return failure(reply, error, now);
    }
  });

  app.get(
    "/app/api/evaluations/:id/poll",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffPoll }, ({ req, scope }) => view(req, scope)),
  );

  app.post(
    "/app/api/evaluations/:id/poll/reveal",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PollRevealBody, optionalBody: true, load: staffPoll },
      async ({ req, now, body, scope }) => {
        const updated = await service.setRevealed(
          app.db,
          scope.evaluation,
          body.revealed,
          now,
          body.votes,
        );
        await trace(req, "poll.reveal", "evaluation", updated.id, {
          revealed: body.revealed,
          ...(body.votes === undefined ? {} : { votes: body.votes }),
        });
        return view(req, { ...scope, evaluation: updated });
      },
    ),
  );

  /** The end of a poll: closed and graded, never released (ADR-014). */
  app.post(
    "/app/api/evaluations/:id/poll/end",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffPoll }, async ({ req, now, scope }) => {
      const closed = await service.endPoll(app, scope.evaluation, now);
      await trace(req, "poll.end", "evaluation", closed.id);
      return view(req, { ...scope, evaluation: closed });
    }),
  );

  /**
   * "Run the same question again": a NEW poll, a new code, a clean tally —
   * for the same audience. An anonymous poll is only ever reached by its
   * owner, so its rerun is theirs as well.
   */
  app.post(
    "/app/api/evaluations/:id/poll/again",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffPoll }, async ({ req, reply, now, scope }) => {
      const again = await service.createPoll(app.db, {
        classroomId: scope.evaluation.classroomId,
        questionId: scope.item.question.id,
        createdBy: req.user!.id,
        now,
      });
      await trace(req, "poll.create", "evaluation", again.evaluation.id, {
        questionId: scope.item.question.id,
        again: scope.evaluation.id,
        code: again.evaluation.accessCode,
      });
      return reply.code(201).send(await view(req, again));
    }),
  );

  /**
   * "Keep this question" (ADR-014, addenda 2026-09-23, item 6): the unsaved
   * question of this poll joins the CALLER's personal pool, created on first
   * use. Whoever manages the poll may keep it (the staff predicate loads the
   * poll, 404 otherwise); a question that already sits in a pool is left
   * where it is and the answer is the current view — idempotent.
   */
  app.post(
    "/app/api/evaluations/:id/poll/keep",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffPoll }, async ({ req, now, scope }) => {
      const outcome = await poolService.keepUnsavedQuestion(app.db, {
        questionId: scope.item.question.id,
        userId: req.user!.id,
        now,
      });
      if (outcome.kept && outcome.poolId) {
        const [kept] = await app.db
          .select({ internalName: questions.internalName })
          .from(questions)
          .where(eq(questions.id, scope.item.question.id));
        await trace(req, "poll.keep", "question", scope.item.question.id, {
          evaluationId: scope.evaluation.id,
          poolId: outcome.poolId,
          internalName: kept?.internalName ?? null,
        });
      }
      const fresh = await service.scopeOf(app.db, scope.evaluation);
      return view(req, fresh ?? scope);
    }),
  );

  // =========================================================================
  // Public side — no session needed for an anonymous poll (F-AUTH-05); the
  // roster and the staff, signed in, for a classroom's
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

  /**
   * The poll a code names, with the browser's identity resolved — or
   * `"not_on_roster"` when a classroom's poll is asked for by a signed-in
   * account that holds neither a seat on its roster nor one on its staff
   * (ADR-014, addendum 2026-09-27). That refusal is a 403 and not a 404: the
   * code is on the wall of the room, so the poll's existence is no secret —
   * what is withheld is its content, and the reason is the one thing the
   * reader can act on (sign in with another account). A browser with no
   * session is told to sign in first (`me.loginRequired`), as before.
   */
  async function publicScope(
    req: FastifyRequest,
    code: string,
    now: Date,
  ): Promise<
    | {
        scope: service.PollScope;
        state: "running" | "ended";
        viewer: service.Viewer & { loggedIn: boolean };
      }
    | "not_on_roster"
    | null
  > {
    const found = await service.byCode(app.db, code, now);
    if (!found) return null;
    if (
      found.evaluation.classroomId !== null &&
      req.user &&
      !(await findReachableEvaluation(app.db, req.user, found.evaluation.id))
    ) {
      return "not_on_roster";
    }
    const scope = await service.scopeOf(app.db, found.evaluation);
    if (!scope) return null;
    const token = req.cookies[service.GUEST_COOKIE];
    const guest =
      req.user || !token ? null : await live.guestByToken(app.db, found.evaluation.id, token);
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

  function notOnRoster(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({
      error: "not_on_roster",
      message: "This poll is for the students of its classroom",
    });
  }

  app.get("/app/api/p/:code", async (req, reply) => {
    const now = app.clock.now();
    const params = PollCodeParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const found = await publicScope(req, params.data.code, now);
    if (!found) return notFound(reply);
    if (found === "not_on_roster") return notOnRoster(reply);
    return service.publicView(app.db, found.scope, found.state, found.viewer);
  });

  /**
   * Joining. A session joins as itself — for a classroom's poll, only when
   * it sits on the roster or the staff (`publicScope`); a browser with no
   * session joins as a guest when the poll is anonymous, and is told to sign
   * in otherwise.
   */
  app.post("/app/api/p/:code/join", async (req, reply) => {
    const now = app.clock.now();
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    const params = PollCodeParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const found = await publicScope(req, params.data.code, now);
    if (!found) return notFound(reply);
    if (found === "not_on_roster") return notOnRoster(reply);
    const { scope, viewer } = found;
    if (found.state !== "running") {
      // Nothing to join any more; the page still shows the question.
      return service.publicView(app.db, scope, found.state, viewer);
    }
    const settings = service.pollSettingsOf(scope.evaluation);
    if (!viewer.loggedIn && !settings.anonymous) {
      return reply.code(401).send({
        error: "login_required",
        message: "This poll is for the students of its classroom",
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
        const guest = await live.ensureGuest(app.db, scope.evaluation.id, token, now);
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
    if (found === "not_on_roster") return notOnRoster(reply);
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
