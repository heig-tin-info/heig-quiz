/**
 * The teacher controls of a running evaluation (§5.1, F-LIVE-11): start,
 * pause, resume, close, extend. Imported through `./service.ts`.
 */
import type { FastifyInstance } from "fastify";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { ClosedBy } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { attempts, enrollments } from "../../db/schema.js";
import {
  applyState,
  byId as evaluationById,
  setClosesAt,
  settingsOf,
  tryApplyState,
  type EvaluationRecord,
} from "../evaluation/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import { type AttemptRecord, attemptById, beginAttempt } from "./attempt.js";
import { logAttemptEvent } from "./autosave.js";

// --- Teacher controls (§5.1, F-LIVE-11) -----------------------------------

interface AttemptWithBonus extends AttemptRecord {
  timeBonusPercent: number;
}

async function attemptsWithBonus(db: Db, evaluation: EvaluationRecord): Promise<AttemptWithBonus[]> {
  const rows = await db
    .select({ attempt: attempts, bonus: enrollments.timeBonusPercent })
    .from(attempts)
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.userId, attempts.userId),
        eq(enrollments.classroomId, evaluation.classroomId),
      ),
    )
    .where(eq(attempts.evaluationId, evaluation.id));
  return rows.map((r) => ({ ...r.attempt, timeBonusPercent: r.bonus ?? 0 }));
}

/** `lobby|scheduled|draft → running` (F-LIVE-03/04). */
export async function startEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "running", now);
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state !== "not_started") continue;
    await beginAttempt(
      db,
      next,
      attempt,
      {
        userId: attempt.userId,
        guestId: attempt.guestId,
        timeBonusPercent: attempt.timeBonusPercent,
      },
      now,
    );
  }
  events.stateChanged(next, now);
  return next;
}

/** `running → paused` (F-LIVE-11). Writes 410 with reason `paused` (D17). */
export async function pauseEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "paused", now);
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state === "in_progress") await logAttemptEvent(db, attempt.id, "paused", null, now);
  }
  events.stateChanged(next, now);
  return next;
}

/**
 * `paused → running`: every in-progress deadline moves forward by exactly the
 * time the evaluation stood still, so a pause never costs a student a second.
 */
export async function resumeEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const pausedFor = evaluation.pausedAt === null ? 0 : now.getTime() - evaluation.pausedAt.getTime();
  // Compare-and-set: a double-clicked resume (or a second ticker process)
  // must not add the pause to every deadline twice.
  let next = await tryApplyState(db, evaluation, "running", now);
  if (next === null) return (await evaluationById(db, evaluation.id))!;
  // In `deadline` timing the common end moves with the pause, exactly as a
  // `+N min` for everybody moves it (`extendTime`): the ticker closes on it,
  // the teacher's countdown reads it, and a student who arrives after the
  // resume gets "until the common end" (F-LIVE-12) — none of them may lose
  // the time the evaluation stood still (#77).
  if (pausedFor > 0 && settingsOf(next).timing === "deadline" && next.closesAt) {
    const closesAt = new Date(next.closesAt.getTime() + pausedFor);
    await setClosesAt(db, next.id, closesAt, now);
    next = { ...next, closesAt };
  }
  if (pausedFor > 0) {
    await db
      .update(attempts)
      .set({
        deadlineAt: sql`${attempts.deadlineAt} + make_interval(secs => ${pausedFor / 1000})`,
        extraS: sql`${attempts.extraS} + ${Math.round(pausedFor / 1000)}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(attempts.evaluationId, next.id),
          eq(attempts.state, "in_progress"),
          isNotNull(attempts.deadlineAt),
        ),
      );
  }
  for (const attempt of await attemptsWithBonus(db, next)) {
    if (attempt.state !== "in_progress") continue;
    await logAttemptEvent(db, attempt.id, "resumed", { pausedMs: pausedFor }, now);
    events.deadlineChanged(next, attempt, "pause_resume", now);
  }
  events.stateChanged(next, now);
  return next;
}

/**
 * `* → closed`: every open attempt becomes `expired`, closed by the teacher.
 *
 * Closing is also what starts the automatic correction (§5.4): when the
 * caller hands over the Fastify instance — the route and the ticker both do —
 * the `grading.evaluation` singleton is enqueued here, so the two entry
 * points cannot drift apart. A caller that passes nothing (a unit test on the
 * transition alone) closes without grading.
 */
export async function closeEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  closedBy: ClosedBy = "teacher",
  app?: FastifyInstance,
): Promise<EvaluationRecord> {
  const open = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.state, "in_progress")));
  await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy, updatedAt: now })
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.state, "in_progress")));
  const next = await applyState(db, evaluation, "closed", now);
  for (const attempt of open) events.attemptClosed(next.id, attempt, closedBy, now);
  events.stateChanged(next, now);
  if (app) await enqueueEvaluationGrading(app, { evaluationId: next.id });
  return next;
}

/** F-LIVE-11/12: +1, +5 or +10 minutes, to everybody or to one student. */
export async function extendTime(
  db: Db,
  evaluation: EvaluationRecord,
  input: { minutes: number; attemptId?: string | undefined },
  now: Date,
): Promise<number> {
  const seconds = input.minutes * 60;
  const target = input.attemptId;
  // In `deadline` timing the attempts hang off `closes_at` (§5.2): extending
  // everybody without moving it would hand the minutes out and let the
  // ticker take them back at the old instant.
  if (target === undefined && settingsOf(evaluation).timing === "deadline" && evaluation.closesAt) {
    const closesAt = new Date(evaluation.closesAt.getTime() + seconds * 1000);
    await setClosesAt(db, evaluation.id, closesAt, now);
    // The dashboard and the players read the new end from this frame.
    events.stateChanged({ ...evaluation, closesAt }, now);
  }
  const where =
    target === undefined
      ? and(eq(attempts.evaluationId, evaluation.id), inArray(attempts.state, ["not_started", "in_progress"]))
      : and(eq(attempts.id, target), eq(attempts.evaluationId, evaluation.id));
  const updated = await db
    .update(attempts)
    .set({
      extraS: sql`${attempts.extraS} + ${seconds}`,
      // A `manual` attempt has no deadline to move; the extra time is still
      // recorded, so a later switch of timing mode is consistent.
      deadlineAt: sql`case when ${attempts.deadlineAt} is null then null else ${attempts.deadlineAt} + make_interval(secs => ${seconds}) end`,
      updatedAt: now,
    })
    .where(where)
    .returning({ id: attempts.id });
  for (const row of updated) {
    const attempt = (await attemptById(db, row.id))!;
    await logAttemptEvent(db, row.id, "time_added", { minutes: input.minutes }, now);
    events.deadlineChanged(evaluation, attempt, "teacher_extend", now);
  }
  return updated.length;
}
