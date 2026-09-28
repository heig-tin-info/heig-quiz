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
  extendClosesAt,
  seatsOf,
  settingsOf,
  tryApplyState,
  type EvaluationRecord,
} from "../evaluation/service.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import {
  type AttemptRecord,
  EvaluationFinished,
  beginAttempt,
} from "./attempt.js";
import { logAttemptEvent, logAttemptEvents } from "./autosave.js";

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
        seatsOf(evaluation),
      ),
    )
    .where(eq(attempts.evaluationId, evaluation.id));
  return rows.map((r) => ({ ...r.attempt, timeBonusPercent: r.bonus ?? 0 }));
}

/**
 * Begins every attempt still `not_started` on an evaluation that has just
 * become `running`: the ones of the lobby at the start, the ones that
 * entered during a pause at the resume. Their clock starts now, never at
 * the entry.
 */
async function beginWaitingAttempts(
  db: Db,
  evaluation: EvaluationRecord,
  rows: readonly AttemptWithBonus[],
  now: Date,
): Promise<void> {
  for (const attempt of rows) {
    if (attempt.state !== "not_started") continue;
    await beginAttempt(
      db,
      evaluation,
      attempt,
      {
        userId: attempt.userId,
        guestId: attempt.guestId,
        timeBonusPercent: attempt.timeBonusPercent,
      },
      now,
    );
  }
}

/** `lobby|scheduled|draft → running` (F-LIVE-03/04). */
export async function startEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "running", now);
  await beginWaitingAttempts(db, next, await attemptsWithBonus(db, next), now);
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
  // must not add the pause to every deadline twice. One transaction: a tick
  // that saw the evaluation `running` before its deadlines moved would expire
  // attempts, or close it, on a clock that still counts the pause.
  const next = await db.transaction(async (tx) => {
    let next = await tryApplyState(tx, evaluation, "running", now);
    if (next === null) return null;
    // In `deadline` timing the common end moves with the pause, exactly as a
    // `+N min` for everybody moves it (`extendTime`): the ticker closes on it,
    // the teacher's countdown reads it, and a student who arrives after the
    // resume gets "until the common end" (F-LIVE-12) — none of them may lose
    // the time the evaluation stood still (#77).
    const movesEnd = pausedFor > 0 && settingsOf(next).timing === "deadline";
    if (movesEnd) {
      next = (await extendClosesAt(tx, next.id, pausedFor / 1000, now)) ?? next;
    }
    if (pausedFor > 0) {
      await tx
        .update(attempts)
        .set({
          deadlineAt: sql`${attempts.deadlineAt} + make_interval(secs => ${pausedFor / 1000})`,
          // Once `closes_at` carries the pause, the attempt's own extra time
          // must not: a reopening recomputes from both (#252).
          ...(movesEnd ? {} : { extraS: sql`${attempts.extraS} + ${Math.round(pausedFor / 1000)}` }),
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
    return next;
  });
  if (next === null) return (await evaluationById(db, evaluation.id))!;
  const rows = await attemptsWithBonus(db, next);
  for (const attempt of rows) {
    if (attempt.state !== "in_progress") continue;
    await logAttemptEvent(db, attempt.id, "resumed", { pausedMs: pausedFor }, now);
    events.deadlineChanged(next, attempt, "pause_resume", now);
  }
  // Last: an attempt that entered during the pause starts on the resume. It
  // sat through no pause, so it gets neither the shift nor a `resumed` entry.
  await beginWaitingAttempts(db, next, rows, now);
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
  // The state FIRST, the attempts after (ADR-025): the flip takes the
  // evaluation row's lock, which a retake holds `FOR SHARE` while it checks
  // `running` and inserts. Whichever goes first, no attempt opened by a
  // retake is left `in_progress` on a closed evaluation — either the retake
  // commits first and is expired below, or it reads `closed` and refuses.
  const next = await applyState(db, evaluation, "closed", now);
  const open = await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy, updatedAt: now })
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.state, "in_progress")))
    .returning({ id: attempts.id });
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
  if (evaluation.state === "closed" || evaluation.state === "released") {
    throw new EvaluationFinished();
  }
  const seconds = input.minutes * 60;
  const target = input.attemptId;
  // In `deadline` timing the attempts hang off `closes_at` (§5.2): extending
  // everybody without moving it would hand the minutes out and let the
  // ticker take them back at the old instant.
  const movesEnd =
    target === undefined && settingsOf(evaluation).timing === "deadline" && evaluation.closesAt !== null;
  if (movesEnd) {
    // Before the start, from now if the end has passed: the way out of a
    // waiting room whose common end went by (#178).
    const started = evaluation.state !== "lobby" && evaluation.state !== "scheduled";
    const committed = await extendClosesAt(db, evaluation.id, seconds, now, !started);
    // The dashboard and the players read the new end from this frame — the
    // row as committed, not `evaluation`, which a concurrent pause or resume
    // may have outdated since this request loaded it.
    if (committed) events.stateChanged(committed, now);
  }
  // Once `closes_at` has moved, the minutes are there and nowhere else: a
  // `not_started` attempt takes its deadline from it when it begins, and a
  // reopened one recomputes from it (#252). Extra time on the attempt as well
  // would count them twice; an `in_progress` one only has its deadline moved.
  const where =
    target === undefined
      ? and(
          eq(attempts.evaluationId, evaluation.id),
          inArray(attempts.state, movesEnd ? ["in_progress"] : ["not_started", "in_progress"]),
        )
      : and(eq(attempts.id, target), eq(attempts.evaluationId, evaluation.id));
  const updated = await db
    .update(attempts)
    .set({
      ...(movesEnd ? {} : { extraS: sql`${attempts.extraS} + ${seconds}` }),
      // A `manual` attempt has no deadline to move; the extra time is still
      // recorded, so a later switch of timing mode is consistent.
      deadlineAt: sql`case when ${attempts.deadlineAt} is null then null else ${attempts.deadlineAt} + make_interval(secs => ${seconds}) end`,
      updatedAt: now,
    })
    .where(where)
    .returning();
  await logAttemptEvents(
    db,
    updated.map((attempt) => attempt.id),
    "time_added",
    { minutes: input.minutes },
    now,
  );
  for (const attempt of updated) events.deadlineChanged(evaluation, attempt, "teacher_extend", now);
  return updated.length;
}
