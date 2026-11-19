/**
 * The teacher controls of a running evaluation (§5.1, F-LIVE-11): start,
 * pause, resume, close, extend. Imported through `./service.ts`.
 */
import type { FastifyInstance } from "fastify";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { ClosedBy, EvaluationClosedBy } from "@quiz/contracts";
import { anchoredOnClosesAt, extendUntilRefusal, untilRefusal } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { attempts, enrollments, officialAttempt } from "../../db/schema.js";
import {
  announceMove,
  applyState,
  byId as evaluationById,
  extendClosesAt,
  moveClosesAtTo,
  seatsOf,
  settingsOf,
  tryApplyState,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { closeShown, endAttempts, openAttemptsOf } from "./dwell.js";
import { endKioskSessions } from "../../auth/session.js";
import * as events from "./events.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import type { AttemptRecord } from "./access.js";
import { ExtendUntilRefused, LiveError } from "./failures.js";
import { beginAttempt } from "./lifecycle.js";
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
    // The live controls drive the official attempts; a practice one (ADR-122)
    // only exists once the evaluation is over, and follows its own deadline.
    .where(and(eq(attempts.evaluationId, evaluation.id), officialAttempt));
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

/**
 * `lobby|scheduled|draft → running` (F-LIVE-03/04), by hand or by the
 * ticker. The students are told (`announceMove`) only when THIS call made
 * the move: a double click or a second ticker process tells nobody twice.
 */
export async function startEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const moved = await tryApplyState(db, evaluation, "running", now);
  const next = moved ?? (await evaluationById(db, evaluation.id))!;
  await beginWaitingAttempts(db, next, await attemptsWithBonus(db, next), now);
  events.stateChanged(next, now);
  if (moved) await announceMove(db, moved, now);
  return next;
}

/** `running → paused` (F-LIVE-11). Writes 410 with reason `paused` (D17). */
export async function pauseEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  const next = await applyState(db, evaluation, "paused", now);
  // The paper is covered (D17): nothing is on screen until the resume, whose
  // players report their question again (ADR-039).
  await closeShown(db, openAttemptsOf(next.id), now);
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
    // When the attempts hang off `closes_at` — a common end, a safety
    // deadline (ADR-086 §2) — it moves with the pause, exactly as a `+N min`
    // for everybody moves it (`extendTime`): the ticker closes on it, the
    // teacher's countdown reads it, and a student who arrives after the
    // resume gets "until the common end" (F-LIVE-12) — none of them may lose
    // the time the evaluation stood still (#77).
    const movesEnd = pausedFor > 0 && anchoredOnClosesAt(settingsOf(next).timing) && next.closesAt !== null;
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
 * the whole-evaluation `grading.evaluation` pass is enqueued here, so the two entry
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
  const next = await applyState(db, evaluation, "closed", now, runCloser(closedBy));
  return afterClose(db, next, now, closedBy, app);
}

/**
 * {@link closeEvaluation} for a caller that must know whether IT closed:
 * null when the compare-and-set was lost (somebody else moved the row since
 * `evaluation` was read), and then nothing is expired, emitted or enqueued.
 */
export async function tryCloseEvaluation(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  closedBy: ClosedBy,
  app?: FastifyInstance,
): Promise<EvaluationRecord | null> {
  const next = await tryApplyState(db, evaluation, "closed", now, runCloser(closedBy));
  return next && afterClose(db, next, now, closedBy, app);
}

/** Who closed the run, as the evaluation keeps it: the server, or a person. */
const runCloser = (closedBy: ClosedBy): EvaluationClosedBy =>
  closedBy === "server" ? "server" : "teacher";

/** What follows the flip to `closed`: the attempts, the frames, the grading. */
async function afterClose(
  db: Db,
  next: EvaluationRecord,
  now: Date,
  closedBy: ClosedBy,
  app?: FastifyInstance,
): Promise<EvaluationRecord> {
  const open = await endAttempts(db, openAttemptsOf(next.id), { state: "expired", closedBy }, now);
  for (const attempt of open) events.attemptClosed(next.id, attempt, closedBy, now);
  events.stateChanged(next, now);
  // Every station seated for it goes back to pairing, a waiting one included.
  await endKioskSessions(db, { evaluationId: next.id, projectId: null });
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
  refuseFinished(evaluation);
  const seconds = input.minutes * 60;
  const target = input.attemptId;
  // In `deadline` timing, and in `manual` timing with a safety deadline
  // (ADR-086 §2), the attempts hang off `closes_at` (§5.2): extending
  // everybody without moving it would hand the minutes out and let the
  // ticker take them back at the old instant. In `duration` timing the end
  // only cuts the attempts, so a running evaluation keeps it (each attempt
  // gets the minutes); before the start the end moves instead — the way out
  // of a waiting room whose end went by (#178) — and carries the minutes
  // alone, as everywhere it moves: on the attempts as well, a student cut
  // at the end would get them twice (ADR-086 §3).
  const started = evaluation.state !== "lobby" && evaluation.state !== "scheduled";
  const movesEnd =
    target === undefined &&
    evaluation.closesAt !== null &&
    (anchoredOnClosesAt(settingsOf(evaluation).timing) || !started);
  if (movesEnd) {
    // Before the start, from now if the end has passed (#178).
    const committed = await extendClosesAt(db, evaluation.id, seconds, now, !started);
    // The dashboard and the players read the new end from this frame — the
    // row as committed, not `evaluation`, which a concurrent pause or resume
    // may have outdated since this request loaded it.
    if (committed) events.stateChanged(committed, now);
  }
  const shifted = await shiftAttempts(
    db,
    evaluation,
    { seconds, movedEnd: movesEnd, attemptId: target },
    { seconds, minutes: input.minutes },
    now,
  );
  return announceDeadlines(evaluation, shifted, now);
}

/**
 * F-LIVE-11 (ADR-086 amendment 2026-11-19): the class's end moved to
 * `until`, a chosen instant. Running only, on a timing whose attempts hang
 * off `closes_at` (`extendUntilRefusal`), later than the current end and
 * than now, within the horizon (`untilRefusal`): both read on the row
 * locked for the write, and the distance too, so a concurrent "+N min"
 * never makes it overshoot. The attempts then move by that distance, as
 * after "+N min" to everybody, in the same transaction: the end never moves
 * without them. No notification: a moved end does not resend the reminder
 * (F-NOTIF-06).
 */
export async function extendUntil(
  db: Db,
  evaluation: EvaluationRecord,
  until: Date,
  now: Date,
): Promise<{ updated: number; previousClosesAt: Date; seconds: number }> {
  const { moved, seconds, shifted } = await db.transaction(async (tx) => {
    const moved = await moveClosesAtTo(tx, evaluation.id, until, now, (locked) => {
      refuseFinished(locked);
      const refusal = extendUntilRefusal({
        state: locked.state,
        timing: settingsOf(locked).timing,
        closesAt: locked.closesAt,
      });
      if (refusal !== null || locked.closesAt === null) throw new ExtendUntilRefused(refusal ?? "no_closes_at");
      const target = untilRefusal(until, locked.closesAt, now);
      if (target !== null) throw new LiveError(`until_${target}`);
      return locked.closesAt;
    });
    const seconds = (until.getTime() - moved.previousClosesAt.getTime()) / 1000;
    const details = { seconds, until: until.toISOString() };
    return { moved, seconds, shifted: await shiftAttempts(tx, evaluation, { seconds, movedEnd: true }, details, now) };
  });
  // The frames once committed; the row as committed, as after "+N min".
  if (moved.row) events.stateChanged(moved.row, now);
  return { updated: announceDeadlines(evaluation, shifted, now), previousClosesAt: moved.previousClosesAt, seconds };
}

/**
 * Extra time on a finished evaluation (`closed`, `released`) moves a
 * deadline nobody can use any more: no extension reopens it.
 */
function refuseFinished(evaluation: EvaluationRecord): void {
  if (evaluation.state === "closed" || evaluation.state === "released") {
    throw new LiveError("evaluation_finished");
  }
}

/**
 * The attempts' side of an extension, the minutes' and the date's alike:
 * `seconds` more on their deadlines, a `time_added` row in their journal
 * (`details`: `seconds` always, beside the `minutes` or the `until` the
 * teacher chose). The moved attempts are returned for
 * {@link announceDeadlines}, once the write is committed.
 */
async function shiftAttempts(
  db: Db | Tx,
  evaluation: EvaluationRecord,
  shift: { seconds: number; movedEnd: boolean; attemptId?: string | undefined },
  details: { seconds: number } & ({ minutes: number } | { until: string }),
  now: Date,
): Promise<AttemptRecord[]> {
  const { seconds, movedEnd, attemptId } = shift;
  // Once `closes_at` has moved, the time is there and nowhere else: a
  // `not_started` attempt takes its deadline from it when it begins, and a
  // reopened one recomputes from it (#252). Extra time on the attempt as well
  // would count it twice; an `in_progress` one only has its deadline moved.
  const where =
    attemptId === undefined
      ? and(
          eq(attempts.evaluationId, evaluation.id),
          inArray(attempts.state, movedEnd ? ["in_progress"] : ["not_started", "in_progress"]),
        )
      : and(eq(attempts.id, attemptId), eq(attempts.evaluationId, evaluation.id));
  const updated = await db
    .update(attempts)
    .set({
      ...(movedEnd ? {} : { extraS: sql`${attempts.extraS} + ${seconds}` }),
      // A `manual` attempt without a safety deadline has no deadline to
      // move; the extra time is still recorded, so a later switch of timing
      // mode is consistent.
      deadlineAt: sql`case when ${attempts.deadlineAt} is null then null else ${attempts.deadlineAt} + make_interval(secs => ${seconds}) end`,
      updatedAt: now,
    })
    .where(where)
    .returning();
  await logAttemptEvents(
    db,
    updated.map((attempt) => attempt.id),
    "time_added",
    details,
    now,
  );
  return updated;
}

/** A `deadlineChanged` frame for each attempt an extension moved; their count. */
function announceDeadlines(evaluation: EvaluationRecord, moved: readonly AttemptRecord[], now: Date): number {
  for (const attempt of moved) events.deadlineChanged(evaluation, attempt, "teacher_extend", now);
  return moved.length;
}
