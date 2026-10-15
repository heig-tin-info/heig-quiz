/**
 * HTTP surface of the `drill` module (ADR-041, #317).
 *
 * Student: today's session, a card served, its time on screen, the review,
 * the opt-out per classroom, and targeted revision by concept (ADR-115). A
 * card or a round is reached by its owner only, and only while it is
 * active; anything else is the 404 of a missing card (invariant 6).
 *
 * Teacher: the drill switch of a classroom, "Allow drill" and "Remove these
 * questions from the drill" on an evaluation, each loaded through
 * `staffAccess` first; and the reads of the teacher's view — each
 * student's activity, the weekly progression, the hours practised, the
 * mastery per concept, the confidence per question (ADR-085 §8, aggregated only), who revised
 * which concept (ADR-115). The student also
 * reads their own calibration and their own concept mastery (ADR-098).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  DrillAnswerBody,
  DrillClassroomBody,
  DrillHoursQuery,
  DrillOptOutBody,
  DrillProgressQuery,
  DrillSessionQuery,
  DrillShownBody,
  EvaluationDrillBody,
  IdParam,
  RevisionAnswerBody,
  RevisionCardParam,
  RevisionRoundBody,
  type DrillCalibrationLevel,
  type DrillCardsRemoved,
  type DrillClassroom,
  type DrillClassroomSettings,
  type EvaluationDrill,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import { accessibleClassroom, callerOf, loadEvaluation, readableClassroom, teacherGuard } from "../guards.js";
import { invalid, notFound, readerLang, studentRoute, teacherRoute } from "../http.js";
import { drillAllowed, setAllowDrill, type EvaluationRecord } from "../evaluation/service.js";
import { setClassroomDrill, setDrillOptOut } from "../org/service.js";
import * as service from "./service.js";

export async function drillPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const requireSession = (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply);
  const teacher = teacherRoute(app);
  const student = studentRoute(app);
  const trace = tracer(app);

  // The loaders of invariant 6. A student's scope is themselves: every card
  // query is filtered by its owner, and a card that is not theirs is a miss.
  const me = async (req: FastifyRequest) => ({ userId: req.user!.id });
  const staffClassroom = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleClassroom(app, req, reply, p);
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  /** What the settings screen reads of an evaluation's drill: the switch and its cards. */
  const evaluationDrill = async (row: EvaluationRecord): Promise<EvaluationDrill> => ({
    allowDrill: drillAllowed(row),
    cards: await service.evaluationCardCount(app.db, row.id),
  });

  // --- Student -------------------------------------------------------------

  /** F-DRILL-03: today's session; an empty one names the next due date. */
  app.get("/app/api/drill/session", { preHandler: requireSession }, async (req, reply) => {
    const now = app.clock.now();
    const query = DrillSessionQuery.safeParse(req.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    return service.drillSession(app.db, req.user!.id, query.data.device, now);
  });

  /** The classrooms whose drill the student is in (or opted out of): the tab's notice and switches. */
  app.get(
    "/app/api/drill/classrooms",
    { preHandler: requireSession },
    async (req): Promise<DrillClassroom[]> => service.studentDrillClassrooms(app.db, req.user!.id),
  );

  /** ADR-085 §8: the student's own calibration, every classroom pooled; nobody else's rows. */
  app.get(
    "/app/api/drill/calibration",
    { preHandler: requireSession },
    async (req): Promise<DrillCalibrationLevel[]> => service.studentCalibration(app.db, req.user!.id),
  );

  /** ADR-041 §6: out of one classroom's drill, or back in. */
  app.put(
    "/app/api/drill/classrooms/:id/opt-out",
    { preHandler: requireSession },
    student({ params: IdParam, body: DrillOptOutBody, load: me }, async ({ reply, now, params, body, scope }) => {
      const [room] = await service.studentDrillClassrooms(app.db, scope.userId, params.id);
      if (!room) return notFound(reply);
      const set = await setDrillOptOut(app.db, params.id, scope.userId, body.optedOut, now);
      if (!set) return notFound(reply);
      return { ...room, optedOutAt: isoOrNull(set.optedOutAt) } satisfies DrillClassroom;
    }),
  );

  /**
   * ADR-098: the caller's own level on each concept their course declares.
   * The classroom is loaded through `readableClassroom` with the STUDENT
   * payload forced, so a teacher in the student view and an impersonation
   * session read their own / the impersonated seat. Portal sessions only: a
   * `seb` or `kiosk` session is refused with a 401 before the route (as the
   * gradebook's is), and anyone off the classroom gets the 404 of a missing one.
   */
  app.get(
    "/app/api/student/classrooms/:id/drill/mastery",
    { preHandler: requireSession },
    student(
      { params: IdParam, load: (req, reply, p) => readableClassroom(app, req, reply, p, { studentView: true }) },
      ({ req, now, scope }) =>
        service.studentConceptMastery(app.db, scope.room, callerOf(req).id, now, readerLang(req)),
    ),
  );

  // Targeted revision (ADR-115): rounds of extra practice on one concept of
  // the course, outside FSRS and the level, on routes of their own. The
  // classroom's are loaded like the mastery's (`readableClassroom`, the
  // student payload forced); a round's, like a card's, by its owner only.
  const studentClassroom = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    readableClassroom(app, req, reply, p, { studentView: true });

  /** The concepts the caller may revise here: the course's validated ones, when revision is open to them. */
  app.get(
    "/app/api/student/classrooms/:id/revision/concepts",
    { preHandler: requireSession },
    student({ params: IdParam, load: studentClassroom }, ({ req, scope }) =>
      service.studentRevisionConcepts(app.db, scope.room, callerOf(req).id, readerLang(req)),
    ),
  );

  /** The caller's own rounds in this classroom, as their teacher sees them. */
  app.get(
    "/app/api/student/classrooms/:id/revision/rounds",
    { preHandler: requireSession },
    student({ params: IdParam, load: studentClassroom }, ({ req, scope }) =>
      service.studentRevisionRounds(app.db, scope.room, callerOf(req).id, readerLang(req)),
    ),
  );

  /** Starts a round on one concept on offer; `{ round: null }` when no card of the caller covers it. */
  app.post(
    "/app/api/student/classrooms/:id/revision/rounds",
    { preHandler: requireSession },
    student({ params: IdParam, body: RevisionRoundBody, load: studentClassroom }, ({ req, now, body, scope }) =>
      service.startRound(app.db, scope.room, callerOf(req).id, body.conceptId, readerLang(req), now),
    ),
  );

  /** A round's card at its next pass, through `studentView` (invariant 4). */
  app.post(
    "/app/api/student/revision/rounds/:id/serve/:cardId",
    { preHandler: requireSession },
    student({ params: RevisionCardParam, load: me }, ({ now, params, scope }) =>
      service.serveRound(app.db, scope.userId, params.id, params.cardId, now),
    ),
  );

  /** The answer to a round's served card: graded, the key shown; no review, no confidence. */
  app.post(
    "/app/api/student/revision/rounds/:id/cards/:cardId/answer",
    { preHandler: requireSession },
    student({ params: RevisionCardParam, body: RevisionAnswerBody, load: me }, ({ now, params, body, scope }) =>
      service.answerRound(app.db, scope.userId, params.id, params.cardId, body, now),
    ),
  );

  /** The student leaves the round. */
  app.post(
    "/app/api/student/revision/rounds/:id/end",
    { preHandler: requireSession },
    student({ params: IdParam, load: me }, async ({ reply, now, params, scope }) => {
      await service.endRound(app.db, scope.userId, params.id, now);
      return reply.code(204).send();
    }),
  );

  /** The question of a card, through `studentView` (invariant 4), with a new seed. */
  app.post(
    "/app/api/drill/cards/:id/serve",
    { preHandler: requireSession },
    student({ params: IdParam, load: me }, ({ now, params, scope }) =>
      service.serveCard(app.db, scope.userId, params.id, now),
    ),
  );

  /** The tab's visibility: the clock of the review runs only while the question is on screen. */
  app.post(
    "/app/api/drill/cards/:id/shown",
    { preHandler: requireSession },
    student({ params: IdParam, body: DrillShownBody, load: me }, async ({ reply, now, params, body, scope }) => {
      await service.reportShown(app.db, scope.userId, params.id, body.shown, now);
      return reply.code(204).send();
    }),
  );

  /** The review: graded, rated, rescheduled, and the key shown (06, question 28 (h)). */
  app.post(
    "/app/api/drill/cards/:id/answer",
    { preHandler: requireSession },
    student({ params: IdParam, body: DrillAnswerBody, load: me }, ({ now, params, body, scope }) =>
      service.answerCard(
        app.db,
        scope.userId,
        params.id,
        { answer: body.answer, deviceClass: body.deviceClass, confidence: body.confidence, coordinates: body.coordinates },
        now,
      ),
    ),
  );

  // --- Teacher -------------------------------------------------------------
  //
  // The state of the switches is read from the classroom's and the
  // evaluation's own details (`drillEnabled`, `allowDrill`); these routes
  // write, except the one read of the cards an evaluation gave rise to.

  /** ADR-041 §6: the teacher enables the drill for a classroom; its students are then in by default. */
  app.put(
    "/app/api/classrooms/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: DrillClassroomBody, load: staffClassroom }, async ({ req, now, body, scope }) => {
      const enabledAt = await setClassroomDrill(app.db, scope.room.id, body.enabled, now);
      // Enabled, the first time or again: the past evaluations' cards (ADR-041 §13).
      const cardsCreated = body.enabled ? await service.backfillClassroom(app.db, scope.room.id, now) : 0;
      if (body.enabled !== (scope.room.drillEnabledAt !== null)) {
        const action = body.enabled ? "drill.enable" : "drill.disable";
        await trace(req, action, "classroom", scope.room.id, body.enabled ? { cardsCreated } : undefined);
      }
      return {
        enabled: enabledAt !== null,
        enabledAt: isoOrNull(enabledAt),
        cardsCreated,
      } satisfies DrillClassroomSettings;
    }),
  );

  /**
   * "Allow drill" and the cards the evaluation gave rise to: the count the
   * settings screen needs to offer "Remove these questions from the drill"
   * (ADR-041 §10, item 3), which the evaluation's detail does not carry.
   */
  app.get(
    "/app/api/evaluations/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) => evaluationDrill(scope.evaluation)),
  );

  /**
   * "Allow drill", the one writer of `settings.allowDrill`, editable until
   * the release (ADR-041 §10, item 3). Turning it off keeps the cards
   * already created: the removal is its own action. Answers the card count.
   */
  app.put(
    "/app/api/evaluations/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: EvaluationDrillBody, load: staffEvaluation }, async ({ req, now, body, scope }) => {
      const row = await setAllowDrill(app.db, scope.evaluation, body.allowDrill, now);
      await trace(req, "drill.allow", "evaluation", row.id, { allowDrill: body.allowDrill });
      return evaluationDrill(row);
    }),
  );

  // The teacher's view (slice 4, ADR-041 §8): reads of the classroom's
  // drill, each loaded through `staffAccess` on the classroom first.

  /** One row per student: activity, recall on repeated reviews, and the opt-out with its date. */
  app.get(
    "/app/api/classrooms/:id/drill/activity",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ now, scope }) =>
      service.classroomActivity(app.db, scope.room.id, now),
    ),
  );

  /** The weeks of one student's progression (`?student=`, an enrollment id of this classroom). */
  app.get(
    "/app/api/classrooms/:id/drill/progress",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: DrillProgressQuery, load: staffClassroom },
      async ({ reply, now, query, scope }) =>
        (await service.classroomProgress(app.db, scope.room, query.student, now)) ?? notFound(reply),
    ),
  );

  /**
   * When the drill is practised, the last 30 days on one week (ADR-041 §8,
   * amendment of 2026-10-14): the classroom's, or one student's (`?student=`).
   */
  app.get(
    "/app/api/classrooms/:id/drill/hours",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, query: DrillHoursQuery, load: staffClassroom },
      async ({ reply, now, query, scope }) =>
        (await service.classroomHours(app.db, scope.room.id, query.student ?? null, now)) ?? notFound(reply),
    ),
  );

  /** Mastery on the course's concepts (#599 step 9a). */
  app.get(
    "/app/api/classrooms/:id/drill/mastery",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ req, now, scope }) =>
      service.classroomMastery(app.db, scope.room, now, readerLang(req)),
    ),
  );

  /** ADR-115: who revised which concept, in rounds of targeted revision; counts, never a card. */
  app.get(
    "/app/api/classrooms/:id/drill/revision",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ req, scope }) =>
      service.classroomRevision(app.db, scope.room, readerLang(req)),
    ),
  );

  /** ADR-085 §8: per question, the classroom's 2×2 of confidence, from enough students only. */
  app.get(
    "/app/api/classrooms/:id/drill/confidence",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ scope }) =>
      service.classroomConfidence(app.db, scope.room.id),
    ),
  );

  /** "Remove these questions from the drill": the cards this evaluation gave rise to, and their reviews. */
  app.delete(
    "/app/api/evaluations/:id/drill/cards",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ req, scope }) => {
      const removed = await service.removeEvaluationCards(app.db, scope.evaluation.id);
      await trace(req, "drill.cards_remove", "evaluation", scope.evaluation.id, { removed });
      return { removed } satisfies DrillCardsRemoved;
    }),
  );
}
