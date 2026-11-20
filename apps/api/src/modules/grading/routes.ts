/**
 * HTTP surface of the `grading` module (PLAN-MVP §4.5).
 *
 * Teacher only, from the first line to the last: nothing here is reachable
 * with a student session, and an evaluation another teacher owns answers 404,
 * never 403 (invariant 6); a write on a released evaluation is the course
 * owner's, a 403 (ADR-068 §3, amended 2026-10-10). Every body is parsed by a schema from
 * `@quiz/contracts` (invariant 7) and every write is audited (invariant 9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AnswerAcceptanceBody,
  AssistantExamContestations,
  ContestationConfirmBody,
  ContestationProposalBody,
  ContestationProposed,
  OpenContestationsQuery,
  type AnswerAcceptanceResult,
  AnswerIdParam,
  BatchValidateBody,
  ContestationResolveBody,
  type ContestationResolution,
  GradingIdParam,
  GradingQuery,
  GradingRunBody,
  IdParam,
  ItemAnswersRecord,
  ItemCountingBody,
  type ItemCountingResult,
  ItemParam,
  type ItemVersions,
  type GradingRunAccepted,
  ManualGradingBody,
  RegradeBody,
  ValidateGradingBody,
} from "@quiz/contracts";
import { evaluationGradingRole } from "@quiz/domain";

import { tracer, type AuditAction } from "../../audit.js";
import { EXPORT_FORMATS, sendExport } from "../../documents/files.js";
import {
  ASSISTANT_REACH,
  assistantEvaluation,
  callerOf,
  loadEvaluation,
  portalContestation,
  proposingContestation,
  staffAnswer,
  staffContestation,
  staffGrading,
  teacherGuard,
  withCourseRole,
} from "../guards.js";
import type { Tx } from "../../db/client.js";
import type { attempts } from "../../db/schema.js";
import { notFound, notFoundError, readerLang, teacherRoute } from "../http.js";
import { joinedItem, joinedItems, staffAttemptIds, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { notifyUsers } from "../notifications/service.js";
import { listVersions } from "../pool/service.js";
import { markModifiedAfterRelease } from "../results/service.js";
import * as events from "./events.js";
import { changeAcceptance } from "./acceptance.js";
import { itemAnswers, itemAnswersDocument } from "./itemAnswers.js";
import { enqueueEvaluationGrading } from "./jobs.js";
import { GradingError } from "./records.js";
import * as service from "./service.js";

/** A contestation as its owner's loaders hand it over (`staffContestation`'s scope). */
interface OwnedContestation {
  contestation: service.ContestationRecord;
  attempt: typeof attempts.$inferSelect;
  evaluation: EvaluationRecord;
  courseId: string;
}

export async function gradingPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** Params, scope, then body: access is loaded before anything else is checked (invariant 6). */
  const teacher = teacherRoute(app);

  const trace = tracer(app);

  // The loaders of invariant 6, each answering its own 404.
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const answerOf = (req: FastifyRequest, reply: FastifyReply, p: { answerId: string }) =>
    staffAnswer(app, req, reply, p.answerId);
  const gradingOf = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    staffGrading(app, req, reply, p.id);

  /**
   * The same loaders for a WRITE, with the role step of ADR-068 §3 (amended
   * 2026-10-10): once the evaluation is released, a correction changes a
   * published grade, which is the owner's as the release is
   * (`evaluationGradingRole`) — `403 owner_required` for an assistant,
   * before the body. Before the release every member grades.
   */
  const gradingRole = (scope: { evaluation: { releasedAt: Date | null } }) =>
    evaluationGradingRole({ released: scope.evaluation.releasedAt !== null });
  const gradedEvaluation = withCourseRole(app, staffEvaluation, (s) => s.classroom.courseId, gradingRole);
  const gradedAnswer = withCourseRole(app, answerOf, (s) => s.courseId, gradingRole);
  const gradedGrading = withCourseRole(app, gradingOf, (s) => s.courseId, gradingRole);

  // --- The automatic pass ------------------------------------------------

  /**
   * `POST /evaluations/:id/grading/run`. The pass skips every cell that
   * already has a validated grading, so pressing the button twice costs a
   * second pass and changes nothing that a teacher settled (#273: never
   * deduplicated, see `enqueueEvaluationGrading`).
   */
  app.post(
    "/app/api/evaluations/:id/grading/run",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: GradingRunBody, optionalBody: true, load: gradedEvaluation },
      async ({ req, reply, body, scope }) => {
        const items = await joinedItems(app.db, scope.evaluation.id);
        const known = new Set(items.map((i) => i.item.id));
        const itemIds = (body.itemIds ?? [...known]).filter((id) => known.has(id));
        const queued = await enqueueEvaluationGrading(app, {
          evaluationId: scope.evaluation.id,
          ...(body.itemIds ? { itemIds } : {}),
        });
        await trace(req, "grading.run", "evaluation", scope.evaluation.id, { itemIds });
        return reply
          .code(202)
          .send({
            evaluationId: scope.evaluation.id,
            itemIds,
            queued,
          } satisfies GradingRunAccepted);
      },
    ),
  );

  app.get(
    "/app/api/evaluations/:id/grading/progress",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.progressOf(app.db, scope.evaluation.id),
    ),
  );

  // --- The panel ---------------------------------------------------------

  /** The questions and the state of each, for the question selector (#107). */
  app.get(
    "/app/api/evaluations/:id/grading/steps",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, load: staffEvaluation }, ({ scope }) =>
      service.gradingSteps(app.db, scope.evaluation),
    ),
  );

  app.get(
    "/app/api/evaluations/:id/grading",
    { preHandler: requireTeacher },
    teacher({ params: IdParam, query: GradingQuery, load: staffEvaluation }, ({ req, query, scope }) =>
      service.gradingQueue(app.db, scope.evaluation, query, callerOf(req).id),
    ),
  );

  /**
   * F-EXP-01 (ADR-121): every enrolled student's answer to one item, as the
   * Markdown file the panel's Export and Copy fetch, the same document as a
   * PDF (ADR-125), or its record, worded in the reader's language. Staff
   * only, beside the results CSV and like it neither anonymised nor audited.
   */
  for (const format of EXPORT_FORMATS) {
    app.get(
      `/app/api/evaluations/:id/items/:itemId/answers.${format}`,
      { preHandler: requireTeacher },
      teacher({ params: ItemParam, load: staffEvaluation }, async ({ req, reply, now, params, scope }) => {
        // The Markdown and the PDF print each answer as text; the record keeps it as stored.
        const found = await itemAnswers(app.db, scope.evaluation, params.itemId, { now, text: format !== "json" });
        if (!found) return notFound(reply);
        return sendExport(reply, format, found, ItemAnswersRecord, () => itemAnswersDocument(found, readerLang(req)));
      }),
    );
  }

  /** The whole history of one answer, newest first (F-GRADE-05). */
  app.get(
    "/app/api/answers/:answerId/gradings",
    { preHandler: requireTeacher },
    teacher({ params: AnswerIdParam, load: answerOf }, ({ scope }) =>
      service.historyOfCell(app.db, scope.answer.attemptId, scope.answer.itemId),
    ),
  );

  // --- Manual correction -------------------------------------------------

  /**
   * F-GRADE-05: the override, with its mandatory comment. Two entry points
   * for one correction (B-10): the cell is found from the answer here, and
   * from the grading below.
   */
  async function applyOverride(
    req: FastifyRequest,
    evaluation: Parameters<typeof events.gradingChanged>[0],
    cell: Omit<Parameters<typeof service.manualOverride>[1], "criteria">,
    item: JoinedItem | null,
    body: ManualGradingBody,
    now: Date,
  ) {
    // An essay's criteria derive a total within range (ADR-118 §6).
    if (body.points !== undefined) service.assertPointsInRange(evaluation, item, cell, body.points);
    const row = await service.manualOverride(
      app.db,
      { ...cell, criteria: service.criteriaOf(item) },
      { points: body.points, criteria: body.criteria, comment: body.comment },
      callerOf(req).id,
      now,
    );
    await afterCorrection(req, evaluation, row, "grading.override");
    return service.toGrading(row);
  }

  app.post(
    "/app/api/answers/:answerId/gradings",
    { preHandler: requireTeacher },
    teacher(
      {
        params: AnswerIdParam,
        body: ManualGradingBody,
        load: async (req, reply, p) => {
          const scope = await gradedAnswer(req, reply, p);
          if (!scope) return null;
          const cell = await service.cellOfAnswer(app.db, p.answerId);
          if (cell) return { evaluation: scope.evaluation, cell };
          await notFound(reply);
          return null;
        },
      },
      ({ req, now, body, scope }) => {
        const { item, ...cell } = scope.cell;
        return applyOverride(req, scope.evaluation, cell, item, body, now);
      },
    ),
  );

  /**
   * The same override for a cell that has NO answer row: F-GRADE-01 grades an
   * absent answer, so the panel shows an entry the plan's `/answers/:id` path
   * cannot address (deviation W6-3).
   */
  app.post(
    "/app/api/gradings/:id/override",
    { preHandler: requireTeacher },
    teacher(
      { params: GradingIdParam, body: ManualGradingBody, load: gradedGrading },
      async ({ req, now, body, scope }) =>
        applyOverride(
          req,
          scope.evaluation,
          {
            attemptId: scope.grading.attemptId,
            itemId: scope.grading.itemId,
            answerId: scope.grading.answerId,
            maxPoints: scope.grading.maxPoints,
          },
          await joinedItem(app.db, scope.evaluation.id, scope.grading.itemId),
          body,
          now,
        ),
    ),
  );

  /** F-GRADE-04: validating one proposal, possibly adjusting it on the way. */
  app.post(
    "/app/api/gradings/:id/validate",
    { preHandler: requireTeacher },
    teacher(
      { params: GradingIdParam, body: ValidateGradingBody, optionalBody: true, load: gradedGrading },
      async ({ req, now, body, scope }) => {
        const item = await joinedItem(app.db, scope.evaluation.id, scope.grading.itemId);
        if (body.points !== undefined) service.assertPointsInRange(scope.evaluation, item, scope.grading, body.points);
        const row = await service.validateGrading(
          app.db,
          scope.grading,
          service.criteriaOf(item),
          body,
          callerOf(req).id,
          now,
        );
        await afterCorrection(req, scope.evaluation, row, "grading.validate");
        return service.toGrading(row);
      },
    ),
  );

  /** F-GRADE-04: the filtered batch ("every high-confidence proposal of q3"). */
  app.post(
    "/app/api/evaluations/:id/grading/validate-batch",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: BatchValidateBody, optionalBody: true, load: gradedEvaluation },
      async ({ req, now, body, scope }) => {
        const validated = await service.batchValidate(
          app.db,
          scope.evaluation.id,
          body,
          callerOf(req).id,
          now,
        );
        if (validated > 0) {
          await markModifiedAfterRelease(app.db, scope.evaluation, now);
          await trace(req, "grading.validate", "evaluation", scope.evaluation.id, {
            ...body,
            validated,
          });
          events.gradingChanged(scope.evaluation);
        }
        return { validated };
      },
    ),
  );

  // --- Regrade (F-GRADE-06) ----------------------------------------------

  /**
   * The published versions a regrade may target (issue #106), newest first,
   * with the number the evaluation froze. Scoped by the evaluation item and
   * loaded through the staff guard, NOT through `poolAccess`: the pool route
   * `GET /questions/:id/versions` refuses a co-teacher once the question's
   * pool is unlinked from the course (or the question moved to a private
   * pool), and whoever may grade the evaluation must still see what they
   * grade against.
   */
  app.get(
    "/app/api/evaluations/:id/items/:itemId/versions",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, load: staffEvaluation },
      async ({ reply, params, scope }): Promise<ItemVersions | FastifyReply> => {
        const item = await joinedItem(app.db, scope.evaluation.id, params.itemId);
        if (!item) return notFound(reply);
        return {
          frozenNumber: item.version.number!,
          versions: await listVersions(app.db, item.question.id),
        };
      },
    ),
  );

  /**
   * Re-grades ONE item across every attempt. Optionally repoints the item at
   * a newer published version first; every grading the pass writes carries
   * `regrade_note`, and the ones it replaces become `superseded`. An item
   * the model grades is re-graded a few times a day at most
   * (`checkLlmRegradeBudget`, audit L2).
   */
  app.post(
    "/app/api/evaluations/:id/items/:itemId/regrade",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: RegradeBody, load: gradedEvaluation },
      async ({ req, reply, now, params, body, scope }) => {
        const item = await joinedItem(app.db, scope.evaluation.id, params.itemId);
        if (!item) return notFound(reply);
        // Audit L2: a re-grade the model answers again has a daily budget per item.
        const llm = await service.checkLlmRegradeBudget(app.db, scope.evaluation.id, item.item.id, now);

        const note = await service.regradeItem(
          app.db,
          {
            evaluationId: scope.evaluation.id,
            itemId: item.item.id,
            questionId: item.question.id,
            variables: item.version.variables,
          },
          body,
        );
        if (note === null) return notFound(reply);
        const queued = await enqueueEvaluationGrading(app, {
          evaluationId: scope.evaluation.id,
          itemIds: [item.item.id],
          regradeNote: note,
        });
        const modified = await markModifiedAfterRelease(app.db, scope.evaluation, now);
        await trace(req, "grading.regrade", "evaluation", scope.evaluation.id, {
          itemId: item.item.id,
          note,
          toVersionNumber: body.toVersionNumber ?? null,
          modifiedAfterRelease: modified,
          ...(llm ? { llm: true } : {}),
        } satisfies service.RegradeAudit);
        events.gradingChanged(scope.evaluation);
        return reply
          .code(202)
          .send({ evaluationId: scope.evaluation.id, itemIds: [item.item.id], queued });
      },
    ),
  );

  /**
   * ADR-108: how an item counts — normal, bonus or neutralized — changed
   * after the evaluation ran, when a question proves incoherent. Only once
   * the item list is frozen (the builder's toggle owns it before), never on
   * a poll, never down to a total of 0; after the release, the owner's
   * (`gradedEvaluation`, ADR-068 §3), and the students whose shown grade
   * moved are told (`changeItemCounting`). Reversible any number of times.
   */
  app.put(
    "/app/api/evaluations/:id/items/:itemId/counting",
    { preHandler: requireTeacher },
    teacher(
      { params: ItemParam, body: ItemCountingBody, load: gradedEvaluation },
      async ({ req, reply, now, params, body, scope }): Promise<ItemCountingResult | FastifyReply> => {
        const outcome = await service.changeItemCounting(app.db, scope.evaluation, params.itemId, body.counting, now);
        if (outcome === null) return notFound(reply);
        if (outcome.changed) {
          await trace(req, "evaluation.item_counting", "evaluation", scope.evaluation.id, {
            itemId: params.itemId,
            before: outcome.before,
            after: body.counting,
            modifiedAfterRelease: outcome.modifiedAfterRelease,
          });
          events.gradingChanged(scope.evaluation);
        }
        return { counting: body.counting, modifiedAfterRelease: outcome.modifiedAfterRelease };
      },
    ),
  );

  /**
   * ADR-128: accepting an answer at grading time (`PUT`), or no longer
   * (`DELETE`, the same body). The rule is the item's, applied by every
   * automatic grading of an official attempt from then on; the act
   * re-grades at once the answers it reaches, a manual override left alone.
   * The gate is the counting act's (ADR-108 §3): once the item list is
   * frozen, never on a poll, the owner's after the release
   * (`gradedEvaluation`), and a released grade that moves tells its student
   * (`writeGradings`).
   */
  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/app/api/evaluations/:id/items/:itemId/acceptances",
      preHandler: requireTeacher,
      handler: teacher(
        { params: ItemParam, body: AnswerAcceptanceBody, load: gradedEvaluation },
        async ({ req, reply, now, params, body, scope }): Promise<AnswerAcceptanceResult | FastifyReply> => {
          const item = await joinedItem(app.db, scope.evaluation.id, params.itemId);
          if (!item) return notFound(reply);
          return (await acceptAnswer(req, scope.evaluation, item, body, method === "PUT", now)) ?? notFound(reply);
        },
      ),
    });
  }

  /**
   * The act of ADR-128 and what follows it — audited when a rule changed or
   * a repeated act healed gradings it had left undone — shared by the
   * route above and a proposal's confirmation (ADR-139 §14). Null when the
   * rule's attempt is not an official attempt of the evaluation.
   */
  async function acceptAnswer(
    req: FastifyRequest,
    evaluation: EvaluationRecord,
    item: JoinedItem,
    body: AnswerAcceptanceBody,
    accepted: boolean,
    now: Date,
    after?: (tx: Tx) => Promise<void>,
  ): Promise<AnswerAcceptanceResult | null> {
    const outcome = await changeAcceptance(app, evaluation, item, body, accepted, callerOf(req).id, now, { after });
    if (outcome === null) return null;
    const result = {
      accepted,
      regraded: outcome.regraded,
      unchanged: outcome.unchanged,
      modifiedAfterRelease: outcome.modifiedAfterRelease,
    };
    if (outcome.changed || outcome.regraded > 0) {
      await trace(req, "evaluation.answer_accepted", "evaluation", evaluation.id, { itemId: item.item.id, ...body, ...result });
      events.gradingChanged(evaluation);
    }
    return result;
  }

  // --- Contestations (ADR-139) --------------------------------------------

  /**
   * The answer to a student's contestation: the course owner's alone, as
   * every grading write after a release (ADR-068 §3) — and still after an
   * unrelease, which a contestation survives (`403 owner_required` for an
   * assistant, before the body). Once (`409 not_open`); a refusal or new
   * points carry a reply (the contract's `answerExplained`, a 400). New
   * points are a manual override, written with the answer in one
   * transaction and followed by what every correction does. The student is
   * told — not a teacher's own test walk (ADR-018), which tells nobody.
   */
  const ownedContestation = withCourseRole(
    app,
    (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => staffContestation(app, req, reply, p.id),
    (s) => s.courseId,
    "owner",
  );
  app.post(
    "/app/api/contestations/:id/resolve",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, body: ContestationResolveBody, load: ownedContestation },
      async ({ req, now, body, scope }): Promise<ContestationResolution> => answerContestation(req, scope, body, now),
    ),
  );

  /**
   * The owner's answer and what follows it, shared by the answer above and
   * a proposal's confirmation (`expect`, ADR-139 §14).
   */
  async function answerContestation(
    req: FastifyRequest,
    scope: OwnedContestation,
    body: ContestationResolveBody,
    now: Date,
    expect?: service.Expected,
  ): Promise<ContestationResolution> {
    const { contestation, evaluation } = scope;
    const item = await joinedItem(app.db, evaluation.id, contestation.itemId);
    if (!item) throw notFoundError("contestation");
    const outcome = await service.resolveContestation(app.db, {
      contestation,
      evaluation,
      item,
      body,
      userId: callerOf(req).id,
      now,
      ...(expect ? { expect } : {}),
    });
    if (outcome.grading) await afterCorrection(req, evaluation, outcome.grading, "grading.override");
    return afterAnswer(req, scope, outcome, body.verdict, expect !== undefined);
  }

  /**
   * What follows an answer: the audit (the caller the actor — the owner,
   * whoever proposed), the refresh hints, and the student told — not a
   * teacher's own test walk (ADR-018), which tells nobody.
   */
  async function afterAnswer(
    req: FastifyRequest,
    scope: OwnedContestation,
    outcome: { row: service.ContestationRecord; grading: service.GradingRecord | null; before: string | null },
    verdict: ContestationResolveBody["verdict"],
    proposal: boolean,
  ): Promise<ContestationResolution> {
    const { contestation, evaluation } = scope;
    await trace(req, "contestation.resolve", "contestation", contestation.id, {
      evaluationId: evaluation.id,
      verdict,
      points: outcome.grading !== null,
      gradingBefore: outcome.before,
      gradingAfter: outcome.row.gradingAtResolutionId,
      ...(proposal ? { proposal: true } : {}),
    });
    await events.contestationChanged(app.db, evaluation, scope.attempt.userId === null ? [] : [scope.attempt.userId]);
    const staff = (await staffAttemptIds(app.db, evaluation)).has(contestation.attemptId);
    if (!staff && scope.attempt.userId !== null) {
      await notifyUsers(app.db, [scope.attempt.userId], {
        kind: "contestation_resolved",
        evaluationId: evaluation.id,
        evaluationTitle: evaluation.title,
        attemptId: contestation.attemptId,
      });
    }
    return {
      contestation: service.staffContestationOf(outcome.row, await service.attemptCounts(app.db, evaluation, scope.attempt)),
      grading: outcome.grading ? service.toGrading(outcome.grading) : null,
      modifiedAfterRelease: outcome.grading !== null && evaluation.releasedAt !== null,
    };
  }

  // --- An assistant's proposals (ADR-139 §14) --------------------------------

  /**
   * The class's OPEN contestations as an assistant reads them, masked and
   * capped, a page from `offset`: a member of the course's staff, by a
   * token of the assistant's reach or their own portal session. The
   * staff's own payloads of the panel stay unmasked and never reach a
   * `quiz` token.
   */
  app.get(
    "/app/api/evaluations/:id/contestations/open",
    { preHandler: requireTeacher, config: ASSISTANT_REACH },
    teacher(
      { params: IdParam, query: OpenContestationsQuery, load: (req, reply, p) => assistantEvaluation(app, req, reply, p.id) },
      async ({ query, scope }) => AssistantExamContestations.parse(await service.assistantContestations(app.db, scope.evaluation, query.offset)),
    ),
  );

  /**
   * An assistant's proposal of the owner's answer: a member of the course's
   * staff — an assistant role may propose — by a token or the portal.
   * Stored on the contestation, never applied; the staff's screens re-read,
   * the student is told nothing. Audited `contestation.propose` (`api_key`
   * through a token), never a text.
   */
  app.put(
    "/app/api/contestations/:id/proposal",
    { preHandler: requireTeacher, config: ASSISTANT_REACH },
    teacher(
      {
        params: IdParam,
        body: ContestationProposalBody,
        load: (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => proposingContestation(app, req, reply, p.id),
      },
      async ({ req, now, body, scope }) => {
        const { contestation, evaluation, attempt } = scope;
        const item = await joinedItem(app.db, evaluation.id, contestation.itemId);
        if (!item) throw notFoundError("contestation");
        const row = await service.propose(app.db, { contestation, attempt, evaluation, item, body, userId: callerOf(req).id, now });
        await trace(req, "contestation.propose", "contestation", contestation.id, {
          kind: "exam",
          evaluationId: evaluation.id,
          verdict: body.verdict,
          points: body.points !== undefined,
          accepted: body.accepted !== undefined,
        });
        await events.contestationChanged(app.db, evaluation, []);
        const proposal = (await service.proposalViews(app.db, evaluation, [row], [item], await service.validatedOfCells(app.db, [row]))).get(row.id)!;
        return ContestationProposed.parse({ id: row.id, evaluationId: evaluation.id, proposal });
      },
    ),
  );

  /**
   * The owner confirms the proposal they read (`proposedAt`): the resolve
   * path above with the stored values; for an accepted answer, ADR-128's
   * act with the answer `accepted` written inside its rule's transaction —
   * a refused answer rolls the acceptance back. Refused `409 not_open`,
   * `409 proposal_stale` (replaced since it was read, or the grading in
   * force moved), `404 no_proposal`. The owner's own portal session.
   */
  app.post(
    "/app/api/contestations/:id/proposal/confirm",
    { preHandler: requireTeacher },
    teacher(
      {
        params: IdParam,
        body: ContestationConfirmBody,
        load: withCourseRole(
          app,
          (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => portalContestation(app, req, reply, p.id),
          (s) => s.courseId,
          "owner",
        ),
      },
      async ({ req, now, body, scope }): Promise<ContestationResolution> => {
        const { contestation, evaluation } = scope;
        await service.assertConfirmable(app.db, contestation, body.proposedAt);
        const expect = { proposedAt: contestation.proposedAt!, grading: contestation.gradingAtProposalId };
        if (!contestation.proposedAcceptance) return answerContestation(req, scope, service.confirmationBody(contestation), now, expect);
        const item = await joinedItem(app.db, evaluation.id, contestation.itemId);
        if (!item) throw notFoundError("contestation");
        const rule = service.proposedRule(contestation.proposedAcceptance, contestation.attemptId);
        const answer = { verdict: "accepted" as const, reply: contestation.proposedReply ?? "", userId: callerOf(req).id, now, gradingId: null };
        let answered: service.ContestationRecord | undefined;
        let regradeFailure: unknown = undefined;
        const accepted = await acceptAnswer(req, evaluation, item, rule, true, now, async (tx) => {
          answered = await service.answerRow(tx, contestation, answer, { ...expect, still: true });
        }).catch(async (error: unknown) => {
          // Nothing committed: the refusal is the act's or the answer's, and the rule rolled back with it.
          if (answered === undefined || (await service.contestationById(app.db, contestation.id))?.state !== "accepted") throw error;
          // The rule and the answer committed, the re-grade after them failed: what the
          // student now reads is answered, so its audit and its notification follow anyway.
          regradeFailure = error;
          req.log.error({ err: error }, "the re-grade after a confirmed accepted answer failed");
          await trace(req, "evaluation.answer_accepted", "evaluation", evaluation.id, { itemId: item.item.id, ...rule, accepted: true, regradeFailed: true });
          return undefined;
        });
        if (accepted === null) throw notFoundError("contestation");
        const row = await service.recordResolutionGrading(app.db, answered!);
        const resolution = await afterAnswer(req, scope, { row, grading: null, before: expect.grading }, "accepted", true);
        if (regradeFailure !== undefined) throw new GradingError("regrade_failed");
        return resolution;
      },
    ),
  );

  /** A proposal discarded, from the portal, by a member of the course's staff (`404 no_proposal` when none stands). */
  app.delete(
    "/app/api/contestations/:id/proposal",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, load: (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => portalContestation(app, req, reply, p.id) },
      async ({ reply, scope }) => {
        if (!(await service.discardProposal(app.db, scope.contestation.id))) throw new GradingError("no_proposal");
        await events.contestationChanged(app.db, scope.evaluation, []);
        return reply.code(204).send();
      },
    ),
  );

  /** What every single-cell correction does afterwards, in one place. */
  async function afterCorrection(
    req: FastifyRequest,
    evaluation: Parameters<typeof events.gradingChanged>[0],
    row: service.GradingRecord,
    action: AuditAction,
  ): Promise<void> {
    await markModifiedAfterRelease(app.db, evaluation, app.clock.now());
    await trace(req, action, "grading", row.id, {
      evaluationId: evaluation.id,
      attemptId: row.attemptId,
      itemId: row.itemId,
      points: row.points,
    });
    events.gradingChanged(evaluation);
  }
}
