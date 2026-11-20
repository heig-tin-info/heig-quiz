/**
 * Contestations of an exam's grading (ADR-139, F-GRADE-08): a student files
 * one per question of the attempt that counts, with a reason; the course
 * owner answers it once, `accepted` or `refused`, an acceptance possibly
 * with new points written as a manual override in the same transaction.
 *
 * The rule — the states, the texts, what may be contested — is
 * `@quiz/domain`'s (`contestation.ts`), shared with a project's criteria
 * (Lot 1b). Here: the table's one writer and its reads. The filing is
 * decided by ONE conditional INSERT on the database's clock (invariant 5);
 * the views' `contestable` flag only offers the control.
 *
 * Nothing of a contestation reaches a student but their own feedback
 * payload (`results.studentFeedback`, invariant 4); the staff read it on
 * the grading panel, the results and the gradebook, through their loaders
 * (invariant 6), and it never names the student there.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  ContestationProposalView,
  ContestationResolveBody,
  NotContestable,
  StaffContestation,
  StudentContestation,
} from "@quiz/contracts";
import { contestedUnit, countsForStudent, proposalStale, unitRefusal, type ContestedUnit, type ContestRefusal } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import {
  answers,
  attempts,
  classrooms,
  contestations,
  evaluations,
  gradings,
  isStaffAttempt,
  officialAttempt,
} from "../../db/schema.js";
import { classroomArchived, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { resultsState } from "../results/service.js";
import { studentAttempts } from "./kept.js";
import { criteriaOf } from "./reads.js";
import { GradingError, pairKey, type AttemptRecord, type GradingRecord, type PairKey } from "./records.js";
import { assertPointsInRange, manualOverride } from "./teacherWrites.js";

export type ContestationRecord = typeof contestations.$inferSelect;

// --- The two readings of a row --------------------------------------------

/** What the student reads of their own contestation; an empty reply is none. A project's criterion reads its row the same way (ADR-139 §13). */
export const studentContestationOf = (row: Pick<ContestationRecord, "state" | "reason" | "filedAt" | "reply" | "resolvedAt">): StudentContestation => ({
  state: row.state,
  reason: row.reason,
  filedAt: iso(row.filedAt),
  reply: row.reply === "" ? null : row.reply,
  resolvedAt: isoOrNull(row.resolvedAt),
});

/**
 * What the staff read: the same, its id, whether its attempt still counts,
 * and the assistant's proposal standing on it (ADR-139 §14, read by
 * `proposalViews`). Never a name.
 */
export const staffContestationOf = (
  row: ContestationRecord,
  counted: boolean,
  proposal: ContestationProposalView | null = null,
): StaffContestation => ({
  ...studentContestationOf(row),
  id: row.id,
  counted,
  proposal,
});

/**
 * The fields of a proposal's staff reading both tables hold alike (ADR-139
 * §14), an exam's contestation's and a project's; null when none stands.
 */
export function proposalBase(
  row: Pick<ContestationRecord, "proposedVerdict" | "proposedReply" | "proposedPoints" | "proposedAt">,
): Pick<ContestationProposalView, "verdict" | "reply" | "points" | "proposedAt"> | null {
  if (row.proposedAt === null || row.proposedVerdict === null) return null;
  return { verdict: row.proposedVerdict, reply: row.proposedReply ?? "", points: row.proposedPoints, proposedAt: iso(row.proposedAt) };
}

/** The columns of a proposal, all cleared: what an answer and a discard write. */
export const NO_PROPOSAL = {
  proposedVerdict: null,
  proposedReply: null,
  proposedPoints: null,
  proposedAcceptance: null,
  proposedBy: null,
  proposedAt: null,
  gradingAtProposalId: null,
} as const;

/**
 * Why a confirmation's conditional write found nothing: the contestation
 * was answered meanwhile (`not_open`), or its proposal changed or its
 * grading moved (`proposal_stale`).
 */
async function confirmationMiss(db: Db | Tx, contestationId: string): Promise<GradingError> {
  const [row] = await db.select({ state: contestations.state }).from(contestations).where(eq(contestations.id, contestationId));
  return new GradingError(row?.state === "open" ? "proposal_stale" : "not_open");
}

/**
 * The SQL that holds while the grading in force is still `recorded` (its
 * row validated; none validated on the cell when null): what an answer
 * without points adds to its conditional UPDATE when it confirms a proposal.
 */
function gradingStillInForce(contestation: Pick<ContestationRecord, "attemptId" | "itemId">, recorded: string | null) {
  return recorded === null
    ? sql`not exists (select 1 from ${gradings} where ${gradings.attemptId} = ${contestation.attemptId}::uuid and ${gradings.itemId} = ${contestation.itemId}::uuid and ${gradings.state} = 'validated')`
    : sql`exists (select 1 from ${gradings} where ${gradings.id} = ${recorded}::uuid and ${gradings.state} = 'validated')`;
}

/** The contestations of one attempt, by item: the student's feedback page. */
export async function contestationsOfAttempt(db: Db, attemptId: string): Promise<Map<string, ContestationRecord>> {
  const rows = await db.select().from(contestations).where(eq(contestations.attemptId, attemptId));
  return new Map(rows.map((row) => [row.itemId, row]));
}

/** The contestations of some items, by cell: the grading panel's selection. */
export async function contestationsOfItems(
  db: Db,
  itemIds: readonly string[],
): Promise<Map<PairKey, ContestationRecord>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.select().from(contestations).where(inArray(contestations.itemId, [...itemIds]));
  return new Map(rows.map((row) => [pairKey(row.attemptId, row.itemId), row]));
}

/**
 * The OPEN contestations of the class, of the given evaluations: on an
 * official attempt (not replaced by a paper copy, ADR-125 §12, not a
 * practice one) and not a teacher's test walk (ADR-018) — per evaluation,
 * per item and per attempt, from one grouped query. The steps, the results
 * and the gradebook all read this one count. An exam takes no retake
 * (ADR-025), so its official attempt IS the one that counts: the kept
 * attempt is not recomputed here, which would cost the tallies of every
 * evaluation of a gradebook.
 */
export async function openContestationCounts(
  db: Db,
  evaluationIds: readonly string[],
): Promise<{ byEvaluation: Map<string, number>; byItem: Map<string, number>; byAttempt: Map<string, number> }> {
  const counts = { byEvaluation: new Map<string, number>(), byItem: new Map<string, number>(), byAttempt: new Map<string, number>() };
  if (evaluationIds.length === 0) return counts;
  const rows = await db
    .select({
      evaluationId: attempts.evaluationId,
      itemId: contestations.itemId,
      attemptId: contestations.attemptId,
      n: sql<number>`count(*)::int`,
    })
    .from(contestations)
    .innerJoin(attempts, eq(attempts.id, contestations.attemptId))
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(
      and(
        inArray(attempts.evaluationId, [...evaluationIds]),
        eq(contestations.state, "open"),
        officialAttempt,
        sql`not ${isStaffAttempt}`,
      ),
    )
    .groupBy(attempts.evaluationId, contestations.itemId, contestations.attemptId);
  const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);
  for (const row of rows) {
    add(counts.byEvaluation, row.evaluationId, row.n);
    add(counts.byItem, row.itemId, row.n);
    add(counts.byAttempt, row.attemptId, row.n);
  }
  return counts;
}

/**
 * The facts of one cell (`contestedUnit` of `@quiz/domain`) — the one
 * builder of the write and of the feedback page, both fed with the
 * VALIDATED grading in force (`null`: pending), so the page never offers
 * what the write refuses.
 */
export function cellUnit(facts: {
  shown: boolean;
  counted: boolean;
  counting: JoinedItem["item"]["counting"];
  validated: Pick<GradingRecord, "points" | "maxPoints"> | null;
}): ContestedUnit {
  return contestedUnit({ ...facts, counting: countsForStudent(facts.counting), grading: facts.validated });
}

/**
 * Whether `attempt` is the one that counts for its student: official (not
 * replaced by a paper copy, not a practice one) and kept (ADR-025).
 */
export async function attemptCounts(db: Db, evaluation: EvaluationRecord, attempt: AttemptRecord): Promise<boolean> {
  if (attempt.userId === null) return false;
  const kept = (await studentAttempts(db, attempt.userId, [evaluation])).get(evaluation.id)?.kept;
  return kept?.id === attempt.id;
}

/** The validated grading of a cell, if any. */
async function validatedOfCell(db: Db | Tx, attemptId: string, itemId: string): Promise<GradingRecord | null> {
  const [row] = await db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), eq(gradings.state, "validated")))
    .limit(1);
  return row ?? null;
}

// --- Filing ------------------------------------------------------------------

/** `409 not_contestable`, its body the contract's (`NotContestable`). */
const notContestable = (reason: ContestRefusal) =>
  new GradingError("not_contestable", undefined, { reason } satisfies Pick<NotContestable, "reason">);

/**
 * The student's one request on one question of their attempt (ADR-139).
 * The loaded rows only CHOOSE a refusal: `409 contestation_closed` when
 * the evaluation is not released or has no window; `409 not_contestable`
 * with the domain's `reason` (`unitRefusal`). The decision is ONE
 * conditional INSERT … SELECT: the window on the database's clock —
 * `now()` before the stored closing instant — a released evaluation whose
 * policy shows results, a classroom not archived, and the validated
 * grading in force, below its full points, read in the same statement
 * (`grading_at_filing_id` never names a superseded row). Its miss is named
 * afterwards: `409 contestation_exists` (one per question), `409
 * classroom_archived`, `409 not_contestable` (`pending`: its grading left
 * meanwhile; `full_points`: it reached them meanwhile), else
 * `contestation_closed`. The reason is the contract's, trimmed and bounded.
 */
export async function fileContestation(
  db: Db,
  input: { evaluation: EvaluationRecord; attempt: AttemptRecord; item: JoinedItem; reason: string; userId: string },
): Promise<ContestationRecord> {
  const { evaluation, attempt, item } = input;
  if (evaluation.releasedAt === null || evaluation.contestationClosesAt === null) {
    throw new GradingError("contestation_closed");
  }
  const refusal = unitRefusal(
    cellUnit({
      shown: resultsState(evaluation, attempt.state) === "available",
      counted: await attemptCounts(db, evaluation, attempt),
      counting: item.item.counting,
      validated: await validatedOfCell(db, attempt.id, item.item.id),
    }),
  );
  if (refusal !== null) throw notContestable(refusal);

  // Every column, in the table's order (an INSERT … SELECT names them all).
  const [row] = await db
    .insert(contestations)
    .select(
      sql`select ${randomUUID()}::uuid, ${attempt.id}::uuid, ${item.item.id}::uuid, ${input.reason}, ${input.userId}::uuid,
        now(), ${gradings.id}, 'open', '', null::uuid, null::timestamptz, null::uuid,
        null, null, null::numeric, null::jsonb, null::uuid, null::timestamptz, null::uuid
      from ${gradings}
      inner join ${attempts} on ${attempts.id} = ${gradings.attemptId}
      inner join ${evaluations} on ${evaluations.id} = ${attempts.evaluationId}
      inner join ${classrooms} on ${classrooms.id} = ${evaluations.classroomId}
      where ${gradings.attemptId} = ${attempt.id}::uuid and ${gradings.itemId} = ${item.item.id}::uuid
        and ${gradings.state} = 'validated' and ${gradings.points} < ${gradings.maxPoints}
        and ${evaluations.releasedAt} is not null and now() < ${evaluations.contestationClosesAt}
        and coalesce(${evaluations.feedbackPolicy}->>'when', 'on_release') <> 'none'
        and ${classrooms.archivedAt} is null`,
    )
    .onConflictDoNothing({ target: [contestations.attemptId, contestations.itemId] })
    .returning();
  if (row) return row;
  if ((await contestationsOfAttempt(db, attempt.id)).has(item.item.id)) throw new GradingError("contestation_exists");
  if (await classroomArchived(db, evaluation)) throw new GradingError("classroom_archived");
  const validated = await validatedOfCell(db, attempt.id, item.item.id);
  if (validated === null) throw notContestable("pending");
  if (validated.points >= validated.maxPoints) throw notContestable("full_points");
  throw new GradingError("contestation_closed");
}

// --- Answering ---------------------------------------------------------------

/**
 * The owner's one answer (ADR-139); the contract checked that it explains
 * itself (`answerExplained`). Without points, one conditional UPDATE
 * (`state = 'open'`: else `409 not_open`), the grading in force recorded
 * beside it. With points (or an essay's criteria), a manual override
 * (F-GRADE-05) of the cell in force — its answer and its maximum, read from
 * the validated grading, or from the item and its answer row when none is
 * — whose comment is the reply, and the answer written in ITS transaction,
 * after the new grading: both commit, or neither — a second answer racing
 * this one finds the row answered and rolls its override back (`409
 * not_open`). Nothing checks that the grading changed: an acceptance may
 * say "you are right, the comment was wrong" and leave the points.
 */
export async function resolveContestation(
  db: Db,
  input: {
    contestation: ContestationRecord;
    evaluation: EvaluationRecord;
    item: JoinedItem;
    body: ContestationResolveBody;
    userId: string;
    now: Date;
    /**
     * A proposal's confirmation (ADR-139 §14): the proposal confirmed is
     * still the one standing (`proposedAt`), and the grading in force is the
     * one it recorded (`grading`), checked by the write itself.
     */
    expect?: Expected;
  },
): Promise<{ row: ContestationRecord; grading: GradingRecord | null; before: string | null }> {
  const { contestation, evaluation, item, body, userId, now, expect } = input;
  const cell = { attemptId: contestation.attemptId, itemId: contestation.itemId };
  const inForce = await validatedOfCell(db, cell.attemptId, cell.itemId);
  const before = inForce?.id ?? null;
  const answer = { verdict: body.verdict, reply: body.reply, userId, now };

  if (body.points === undefined && body.criteria === undefined) {
    const row = await answerRow(db, contestation, { ...answer, gradingId: before }, expect && { ...expect, still: true });
    return { row, grading: null, before };
  }

  const maxPoints = inForce?.maxPoints ?? item.item.points;
  if (body.points !== undefined) assertPointsInRange(evaluation, item, { maxPoints }, body.points);
  const answerId = inForce ? inForce.answerId : await answerIdOf(db, cell);
  let row: ContestationRecord | undefined;
  const grading = await manualOverride(
    db,
    { ...cell, answerId, maxPoints, criteria: criteriaOf(item) },
    { points: body.points, criteria: body.criteria, comment: body.reply },
    userId,
    now,
    {
      // A confirmation: the cell locked, the grading in force must still be the one the proposal read.
      before:
        expect &&
        (async (tx) => {
          const held = await validatedOfCell(tx, cell.attemptId, cell.itemId);
          if (proposalStale(expect.grading, held?.id ?? null)) throw new GradingError("proposal_stale");
        }),
      // The grading it read was checked under the lock, before this override replaced it.
      after: async (tx, written) => {
        row = await answerRow(tx, contestation, { ...answer, gradingId: written[0]!.id }, expect && { ...expect, still: false });
      },
    },
  );
  return { row: row!, grading, before };
}

/** What a proposal's confirmation expects still to stand (ADR-139 §14): the proposal read, and the grading in force it recorded. */
export interface Expected {
  proposedAt: Date;
  grading: string | null;
}

/**
 * THE write of an answer (ADR-139): one conditional UPDATE on an open
 * contestation (`409 not_open` otherwise), the proposal standing cleared,
 * confirmed or not. A confirmation (`expect`) also requires the proposal
 * read, and — `still` — the grading it recorded still in force (else `409
 * proposal_stale`). Used by the owner's answer, with or without new points,
 * and by an accepted answer's confirmation inside ADR-128's rule
 * transaction (`changeAcceptance`'s `after`), so a refused answer rolls the
 * acceptance back; the act's re-grade is recorded after its commit
 * ({@link recordResolutionGrading}).
 */
export async function answerRow(
  tx: Db | Tx,
  contestation: ContestationRecord,
  answer: { verdict: ContestationResolveBody["verdict"]; reply: string; userId: string; now: Date; gradingId: string | null },
  expect?: Expected & { still: boolean },
): Promise<ContestationRecord> {
  const [row] = await tx
    .update(contestations)
    .set({
      state: answer.verdict,
      reply: answer.reply,
      resolvedBy: answer.userId,
      resolvedAt: answer.now,
      gradingAtResolutionId: answer.gradingId,
      ...NO_PROPOSAL,
    })
    .where(
      and(
        eq(contestations.id, contestation.id),
        eq(contestations.state, "open"),
        expect && eq(contestations.proposedAt, expect.proposedAt),
        expect?.still ? gradingStillInForce(contestation, expect.grading) : undefined,
      ),
    )
    .returning();
  if (row) return row;
  throw expect ? await confirmationMiss(tx, contestation.id) : new GradingError("not_open");
}

/** A contestation by its id; undefined when none. */
export async function contestationById(db: Db, id: string): Promise<ContestationRecord | undefined> {
  const [row] = await db.select().from(contestations).where(eq(contestations.id, id));
  return row;
}

/** The validated grading in force on an answered contestation's cell, recorded as the one after its answer. */
export async function recordResolutionGrading(db: Db, row: ContestationRecord): Promise<ContestationRecord> {
  const inForce = await validatedOfCell(db, row.attemptId, row.itemId);
  const [updated] = await db
    .update(contestations)
    .set({ gradingAtResolutionId: inForce?.id ?? null })
    .where(eq(contestations.id, row.id))
    .returning();
  return updated ?? row;
}

/** The answer row of a cell, if the student wrote one. */
async function answerIdOf(db: Db, cell: { attemptId: string; itemId: string }): Promise<string | null> {
  const [given] = await db
    .select({ id: answers.id })
    .from(answers)
    .where(and(eq(answers.attemptId, cell.attemptId), eq(answers.itemId, cell.itemId)))
    .limit(1);
  return given?.id ?? null;
}
