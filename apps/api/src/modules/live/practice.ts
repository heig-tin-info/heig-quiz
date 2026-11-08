/**
 * Practice after the due date (ADR-122): entering it and starting a new
 * practice attempt on an exercise that is over.
 */
import { and, asc, eq } from "drizzle-orm";

import type { AttemptView, ReadyView } from "@quiz/contracts";
import { isFinishedAttempt, practiceCooldownS, practiceDeadline, practiceRefusal } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, classrooms, evaluations } from "../../db/schema.js";
import { practiceOpen, settingsOf, type DbOrTx, type EvaluationRecord } from "../evaluation/service.js";
import type { AttemptRecord, Participant } from "./access.js";
import { PracticeRefused, RateLimited } from "./failures.js";
import { drawInstances, drawSeed, insertAttempt } from "./lifecycle.js";
import { attemptView, practiceConditions } from "./views.js";

/**
 * Where a student stands for practice on one evaluation, from ONE read of
 * their attempts: the unfinished practice attempt to resume, whether an
 * official attempt is left unfinished, the latest practice one (for the
 * minute between two), and the next attempt number.
 */
async function practiceState(tx: DbOrTx, evaluationId: string, userId: string) {
  const mine = await tx
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluationId), eq(attempts.userId, userId)))
    .orderBy(asc(attempts.attemptNumber));
  const unfinished = mine.filter((a) => !isFinishedAttempt(a.state));
  return {
    open: unfinished.find((a) => a.afterDue) ?? null,
    unfinishedOfficial: unfinished.some((a) => !a.afterDue),
    lastPractice: mine.filter((a) => a.afterDue).at(-1) ?? null,
    nextNumber: (mine.at(-1)?.attemptNumber ?? 0) + 1,
  };
}

/**
 * Whether the evaluation's classroom is archived: it takes no writes
 * (ADR-122 §1). The student's loader read it with their seat; the staff's
 * did not (`archived: null`), and it is read here then.
 */
async function classroomArchived(db: DbOrTx, evaluation: EvaluationRecord, archived: boolean | null): Promise<boolean> {
  if (archived !== null) return archived;
  if (evaluation.classroomId === null) return false;
  const [row] = await db
    .select({ archivedAt: classrooms.archivedAt })
    .from(classrooms)
    .where(eq(classrooms.id, evaluation.classroomId))
    .limit(1);
  return row?.archivedAt != null;
}

/** The practice rule for this student now, refused as `409 practice_refused`. */
async function assertPractice(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  archived: boolean | null,
  unfinishedOfficial: boolean,
): Promise<void> {
  const refusal = practiceRefusal({
    open: practiceOpen(evaluation),
    evaluationState: evaluation.state,
    archived: await classroomArchived(db, evaluation, archived),
    unfinishedOfficial,
  });
  if (refusal !== null) throw new PracticeRefused(refusal);
}

/** What the practice routes are given: the evaluation, who practises, and the loader's `archived`. */
interface PracticeInput {
  evaluation: EvaluationRecord;
  participant: Participant;
  archived: boolean | null;
  now: Date;
}

/**
 * `POST /evaluations/:id/practice` (ADR-122): what the practice route shows
 * — the student's unfinished practice attempt, resumed, or the ready screen
 * of a new one (its conditions shown again before Start, F-EVAL-33). Writes
 * nothing. Refused (`409 practice_refused`) where a new one could not start;
 * an unfinished one is resumed even if the teacher hid the practice since.
 */
export async function practiceEntry(
  db: Db,
  input: PracticeInput,
): Promise<{ kind: "attempt"; view: AttemptView } | { kind: "ready"; view: ReadyView }> {
  const { evaluation, participant, now } = input;
  if (participant.userId === null) throw new PracticeRefused("hidden");
  const state = await practiceState(db, evaluation.id, participant.userId);
  if (state.open !== null) {
    return { kind: "attempt", view: await attemptView(db, evaluation, state.open, now, participant) };
  }
  await assertPractice(db, evaluation, input.archived, state.unfinishedOfficial);
  return {
    kind: "ready",
    view: {
      conditions: practiceConditions(evaluation, participant.timeBonusPercent),
      evaluation: { id: evaluation.id, title: evaluation.title },
    },
  };
}

/**
 * `POST /evaluations/:id/practice/start` (ADR-122): a NEW practice attempt
 * on an exercise that is over — blank, a new seed (a new order, new values),
 * never a partial retake (ADR-091), started at once with its own deadline
 * (`practiceDeadline`). Unlimited, one unfinished at a time: an unfinished
 * practice attempt is answered instead of a new one. At most one new
 * attempt a minute (`429 rate_limited`).
 *
 * The rule is read inside a transaction that holds the evaluation row
 * `FOR SHARE`; its number follows every attempt of the student's, practice
 * included, so the unique index `(evaluation, user, number)` lets one of two
 * racing clicks in, and the loser resumes the winner's attempt.
 */
export async function startPractice(
  db: Db,
  input: PracticeInput,
): Promise<{ row: AttemptRecord; created: boolean }> {
  const { participant, now } = input;
  if (participant.userId === null) throw new PracticeRefused("hidden");
  const userId = participant.userId;

  const outcome = await db.transaction(async (tx) => {
    const [evaluation] = await tx
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, input.evaluation.id))
      .for("share");
    if (!evaluation) throw new PracticeRefused("not_over");
    const state = await practiceState(tx, evaluation.id, userId);
    if (state.open !== null) return { evaluation, row: state.open, created: false };
    await assertPractice(tx, evaluation, input.archived, state.unfinishedOfficial);
    const wait = practiceCooldownS(state.lastPractice?.createdAt ?? null, now);
    if (wait > 0) throw new RateLimited(wait);

    const settings = settingsOf(evaluation);
    const seed = drawSeed();
    const row = await insertAttempt(tx, {
      evaluation,
      participant,
      number: state.nextNumber,
      seed,
      instances: await drawInstances(tx, evaluation, seed),
      deadlineAt: practiceDeadline({
        startedAt: now,
        timing: settings.timing,
        durationS: evaluation.durationS,
        timeBonusPercent: participant.timeBonusPercent,
      }),
      bonusS: 0,
      afterDue: true,
      now,
    });
    return { evaluation, row, created: row !== null };
  });

  if (outcome.row === null) {
    // Lost the race: resume the attempt the winner opened.
    const row = (await practiceState(db, outcome.evaluation.id, userId)).open;
    if (!row) throw new PracticeRefused("unfinished");
    return { row, created: false };
  }
  return { row: outcome.row, created: outcome.created };
}
