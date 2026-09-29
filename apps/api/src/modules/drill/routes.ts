/**
 * HTTP surface of the `drill` module (ADR-041, #317).
 *
 * Student: today's session, a card served, its time on screen, the review,
 * and the opt-out per classroom. A card is reached by its owner only, and
 * only while it is active; anything else is the 404 of a missing card
 * (invariant 6).
 *
 * Teacher: the drill switch of a classroom, "Allow drill" and "Remove these
 * questions from the drill" on an evaluation, each student's activity and
 * the mastery per tag — every one loaded through `staffAccess` first.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  DrillAnswerBody,
  DrillClassroomBody,
  DrillOptOutBody,
  DrillSessionQuery,
  DrillShownBody,
  EvaluationDrillBody,
  IdParam,
  type DrillClassroom,
  type DrillClassroomSettings,
  type EvaluationDrill,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import { accessibleClassroom, loadEvaluation, teacherGuard } from "../guards.js";
import { invalid, notFound, studentRoute, teacherRoute } from "../http.js";
import { drillAllowed, setAllowDrill } from "../evaluation/service.js";
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
      service.answerCard(app.db, scope.userId, params.id, { answer: body.answer, deviceClass: body.deviceClass }, now),
    ),
  );

  // --- Teacher -------------------------------------------------------------

  const classroomSettings = (enabledAt: Date | null): DrillClassroomSettings => ({
    enabled: enabledAt !== null,
    enabledAt: isoOrNull(enabledAt),
  });

  app.get(
    "/app/api/classrooms/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ scope }) => classroomSettings(scope.room.drillEnabledAt)),
  );

  /** ADR-041 §6: the teacher enables the drill for a classroom; its students are then in by default. */
  app.put(
    "/app/api/classrooms/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: DrillClassroomBody, load: staffClassroom }, async ({ req, now, body, scope }) => {
      const enabledAt = await setClassroomDrill(app.db, scope.room.id, body.enabled, now);
      if (body.enabled !== (scope.room.drillEnabledAt !== null)) {
        await trace(req, body.enabled ? "drill.enable" : "drill.disable", "classroom", scope.room.id);
      }
      return classroomSettings(enabledAt);
    }),
  );

  /** Each student's activity (ADR-041 §8): questions seen, sessions, recall rate on repeated reviews. */
  app.get(
    "/app/api/classrooms/:id/drill/activity",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ now, scope }) =>
      service.classroomActivity(app.db, scope.room.id, now),
    ),
  );

  /** Mastery per tag (ADR-041 §10, item 10). */
  app.get(
    "/app/api/classrooms/:id/drill/mastery",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffClassroom }, ({ now, scope }) =>
      service.classroomMastery(app.db, scope.room.id, now),
    ),
  );

  app.get(
    "/app/api/evaluations/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ scope }): Promise<EvaluationDrill> => ({
      allowDrill: drillAllowed(scope.evaluation),
      cards: await service.evaluationCardCount(app.db, scope.evaluation.id),
    })),
  );

  /**
   * "Allow drill", editable until the release (ADR-041 §10, item 3). Turning
   * it off keeps the cards already created: the removal is its own action.
   */
  app.put(
    "/app/api/evaluations/:id/drill",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, body: EvaluationDrillBody, load: staffEvaluation }, async ({ req, now, body, scope }) => {
      const row = await setAllowDrill(app.db, scope.evaluation, body.allowDrill, now);
      await trace(req, "evaluation.update", "evaluation", row.id, { allowDrill: body.allowDrill });
      return {
        allowDrill: drillAllowed(row),
        cards: await service.evaluationCardCount(app.db, row.id),
      } satisfies EvaluationDrill;
    }),
  );

  /** "Remove these questions from the drill": the cards this evaluation gave rise to, and their reviews. */
  app.delete(
    "/app/api/evaluations/:id/drill/cards",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ req, scope }) => {
      const removed = await service.removeEvaluationCards(app.db, scope.evaluation.id);
      await trace(req, "drill.cards_remove", "evaluation", scope.evaluation.id, { removed });
      return { removed };
    }),
  );
}
