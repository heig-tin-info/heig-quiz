/**
 * HTTP surface of the `results` module (PLAN-MVP §4.6).
 *
 * The teacher half serves the grade table, the statistics, the per-question
 * view and the CSV; the student half serves their own attempt, through the
 * feedback policy, and the list of their finished work (the Grades page).
 *
 * The student route goes through `studentFeedback()` and nothing else: it is
 * the second half of the content gate of docs/05 §5.7, and the reason the
 * route itself contains no policy logic at all.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AttemptParam,
  ContestationFileBody,
  type ContestationWindow,
  ContestationWindowBody,
  IdParam,
  ItemParam,
  PublishCorrectionBody,
  ReleaseBody,
  StaffCopyRecord,
  type StudentContestation,
} from "@quiz/contracts";

import { readTracer, tracer } from "../../audit.js";
import { iso } from "../../clock.js";
import { sendExport } from "../../documents/files.js";
import { callerOf, loadEvaluation, loadEvaluationAttempt, ownAttempt, teacherGuard, withCourseRole } from "../guards.js";
import { notFound, readerLang, sendCsv, studentRoute, teacherRoute } from "../http.js";
import { byId, joinedItem, staffAttemptIds } from "../evaluation/service.js";
import * as gradingEvents from "../grading/events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import { fileContestation, studentContestationOf } from "../grading/service.js";
import { notifyUsers } from "../notifications/service.js";
import { studentGrades } from "../live/service.js";
import * as bus from "../realtime/bus.js";
import { staffCopyDocument, staffCopyRecord } from "./copy.js";
import { csvFilename, resultsCsv } from "./csv.js";
import * as service from "./service.js";

export async function resultsPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);
  const requireSession = (req: FastifyRequest, reply: FastifyReply) =>
    app.requireSession(req, reply);

  const teacher = teacherRoute(app);
  const student = studentRoute(app);

  const trace = tracer(app);
  const traceRead = readTracer(app);

  // The loaders of invariant 6, each answering its own 404.
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  /**
   * What reaches the students — a release, its withdrawal, a published
   * correction — is the course owner's call (ADR-068): an assistant gets
   * `403 owner_required`, before the body is parsed.
   */
  const ownerEvaluation = withCourseRole(
    app,
    staffEvaluation,
    (scope) => scope.classroom.courseId,
    "owner",
  );
  const staffEvaluationAttempt = loadEvaluationAttempt(app);
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

  /** One student's copy, opened from a row of the grade table; audited once per opening (#875). */
  app.get(
    "/app/api/evaluations/:id/results/attempts/:attemptId",
    { preHandler: requireTeacher },
    teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, scope }) => {
      const copy = await service.staffCopy(app.db, scope.evaluation, scope.attempt);
      await traceRead(req, "attempt.read", "attempt", scope.attempt.id, {
        evaluationId: scope.evaluation.id,
        view: "copy",
      });
      return copy;
    }),
  );

  /**
   * The same copy as a file (ADR-125 §4, §5): its record, or its PDF, from the
   * results per-student view and the dashboard's inspect view — never from
   * the anonymised grading table (F-GRADE-03). Audited as an opening of the
   * copy, like the read above.
   */
  for (const format of ["json", "pdf"] as const) {
    app.get(
      `/app/api/evaluations/:id/results/attempts/:attemptId/copy.${format}`,
      { preHandler: requireTeacher },
      teacher({ params: AttemptParam, load: staffEvaluationAttempt }, async ({ req, reply, now, scope }) => {
        const found = await staffCopyRecord(app.db, scope.evaluation, scope.attempt, { now });
        await traceRead(req, "attempt.read", "attempt", scope.attempt.id, {
          evaluationId: scope.evaluation.id,
          view: "copy",
        });
        // A refused PDF (503) is still an opening: access was granted and the record built.
        return sendExport(reply, format, found, StaffCopyRecord, () => staffCopyDocument(found, readerLang(req)));
      }),
    );
  }

  /** F-RES-02. UTF-8 with a BOM and `;`, because Excel is the reader. */
  app.get(
    "/app/api/evaluations/:id/results.csv",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, async ({ reply, scope }) => {
      const view = await service.resultsView(app.db, scope.evaluation);
      return sendCsv(reply, csvFilename(scope.evaluation.title), resultsCsv(view));
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
      { params: IdParam, body: ReleaseBody, optionalBody: true, load: ownerEvaluation },
      async ({ req, now, scope }) => {
        const again = scope.evaluation.releasedAt !== null;
        const released = await service.releaseResults(app.db, scope.evaluation, now);
        const action = again ? "results.rerelease" : "results.release";
        await trace(req, action, "evaluation", scope.evaluation.id, {
          rows: released.rows,
          journalPurged: released.journalPurged,
        });
        await announce(scope.evaluation.id);
        return { releasedAt: iso(released.releasedAt), rows: released.rows, released: true };
      },
    ),
  );

  /**
   * ADR-050: the correction of a running exercise — the class
   * debrief opens, each student's correction follows the feedback policy as
   * if released, and the finished attempts nothing graded yet go to the
   * grading pass. Irreversible; idempotent (a repeat answers the first
   * instant, audits and grades nothing).
   */
  app.post(
    "/app/api/evaluations/:id/publish-correction",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: PublishCorrectionBody, load: ownerEvaluation },
      async ({ req, now, scope }) => {
        const published = await service.publishCorrection(app.db, scope.evaluation, now);
        if (published.first) {
          await trace(req, "evaluation.correction_publish", "evaluation", scope.evaluation.id, {
            queued: published.toGrade.length,
          });
          if (published.toGrade.length > 0) {
            await enqueueEvaluationGrading(app, {
              evaluationId: scope.evaluation.id,
              attemptIds: published.toGrade,
            });
          }
          // The students' results pages re-read: the correction may be theirs now.
          gradingEvents.resultsChanged(scope.evaluation, []);
        }
        return {
          correctionPublishedAt: iso(published.publishedAt),
          queued: published.toGrade.length,
        };
      },
    ),
  );

  /** Withdrawing a release (a wrong key, a question to re-grade first). */
  app.post(
    "/app/api/evaluations/:id/unrelease",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: ownerEvaluation }, async ({ req, now, scope }) => {
      await service.unreleaseResults(app.db, scope.evaluation, now);
      await trace(req, "results.unrelease", "evaluation", scope.evaluation.id);
      await announce(scope.evaluation.id);
      return { releasedAt: null, rows: 0, released: false };
    }),
  );

  // --- Student -----------------------------------------------------------

  /**
   * The student's Grades page (F-RES-04, F-ORG-14): their finished work by
   * classroom, the grade only where the feedback policy lets it through.
   * The home's Past rule, so it lives beside the home (`live`).
   */
  app.get("/app/api/student/results", { preHandler: requireSession }, async (req) =>
    studentGrades(app.db, callerOf(req).id, app.clock.now()),
  );

  /**
   * THE student feedback view. Before the release — or under a policy that
   * shows nothing — the answer carries a reason and no question content at
   * all (`available: false`).
   */
  app.get(
    "/app/api/attempts/:id/feedback",
    { preHandler: requireSession },
    student({ params: IdParam, load: own }, ({ scope, now }) =>
      service.studentFeedback(app.db, scope.evaluation, scope.attempt, now),
    ),
  );

  /**
   * ADR-139: the student contests the grading of ONE question of their
   * attempt, once, with a reason. The caller's own attempt or the 404 of a
   * missing one (`ownAttempt`); portal sessions only (no `sessions` listed:
   * a `seb` or `kiosk` session is nobody here, ADR-027), and an
   * impersonation stays read-only in production (ADR-034). The service
   * decides on the database's clock and answers every refusal
   * (`contestation_closed`, `contestation_exists`, `not_contestable`,
   * `classroom_archived`). The course's staff are told, folded per
   * evaluation — not of a teacher's own test walk (ADR-018).
   */
  app.post(
    "/app/api/attempts/:id/items/:itemId/contestation",
    { preHandler: requireSession },
    student(
      { params: ItemParam, body: ContestationFileBody, load: own },
      async ({ req, reply, params, body, scope }): Promise<StudentContestation | FastifyReply> => {
        const { evaluation, attempt } = scope;
        const item = await joinedItem(app.db, evaluation.id, params.itemId);
        if (!item) return notFound(reply);
        const row = await fileContestation(app.db, {
          evaluation,
          attempt,
          item,
          reason: body.reason,
          userId: callerOf(req).id,
        });
        await trace(req, "contestation.file", "contestation", row.id, {
          evaluationId: evaluation.id,
          attemptId: attempt.id,
          itemId: item.item.id,
        });
        // The staff alone re-read (N-SEC-20): the student has this reply.
        await gradingEvents.contestationChanged(app.db, evaluation, []);
        if (!(await staffAttemptIds(app.db, evaluation)).has(attempt.id)) {
          await notifyUsers(app.db, await gradingEvents.staffOf(app.db, evaluation), {
            kind: "contestation_filed",
            evaluationId: evaluation.id,
            evaluationTitle: evaluation.title,
            count: 1,
          });
        }
        return studentContestationOf(row);
      },
    ),
  );

  /**
   * ADR-139: the owner closes the contestation window of a released exam
   * now, or extends it to a later instant (which may reopen it). Audited
   * with the act and the instant.
   */
  app.put(
    "/app/api/evaluations/:id/contestation-window",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ContestationWindowBody, load: ownerEvaluation },
      async ({ req, now, body, scope }): Promise<ContestationWindow> => {
        const closesAt = await service.changeContestationWindow(app.db, scope.evaluation, body, now);
        await trace(req, "evaluation.contestation_window", "evaluation", scope.evaluation.id, {
          action: body.action,
          closesAt: iso(closesAt),
        });
        return { closesAt: iso(closesAt) };
      },
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
