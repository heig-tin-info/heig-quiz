/**
 * The ticker tasks (§5.3): expire, auto-open, auto-start, auto-close and
 * the presence sweep. Each is one idempotent pass driven by the server's
 * clock (invariant 5). Imported through `./service.ts`.
 */
import type { FastifyInstance } from "fastify";

import { and, eq, inArray, isNotNull, lte, max, notInArray, sql } from "drizzle-orm";
import { GRACE_MS } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, evaluations } from "../../db/schema.js";
import { applyState, byId, settingsOf, type EvaluationRecord } from "../evaluation/service.js";
import * as events from "./events.js";
import { presence } from "../realtime/presence.js";
import { type AttemptRecord, enrolledCounts, gradeFinishedRetakes } from "./attempt.js";
import { startEvaluation, closeEvaluation } from "./control.js";

// --- Ticker tasks (§5.3) --------------------------------------------------

/**
 * Step 1: expire everything past `deadline + GRACE_MS`. One conditional
 * UPDATE, so re-running a tick is free and catching up after an outage is
 * free (`RETURNING` tells us exactly what changed, and nothing else moved).
 *
 * An attempt of a PAUSED evaluation is never expired: its countdown is
 * frozen, and the resume pushes its deadline forward by the whole pause
 * (`resumeEvaluation`). Expiring it here would let a deadline that only
 * looks past — because the pause has not been added yet — take the exam
 * away from a student who still has time (#77).
 */
export async function expireDueAttempts(
  db: Db,
  now: Date,
  app?: FastifyInstance,
): Promise<{ id: string; evaluationId: string }[]> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const closed = await db
    .update(attempts)
    .set({ state: "expired", closedAt: now, closedBy: "server", updatedAt: now })
    .where(
      and(
        eq(attempts.state, "in_progress"),
        isNotNull(attempts.deadlineAt),
        lte(attempts.deadlineAt, cutoff),
        notInArray(
          attempts.evaluationId,
          db.select({ id: evaluations.id }).from(evaluations).where(eq(evaluations.state, "paused")),
        ),
      ),
    )
    .returning({ id: attempts.id, evaluationId: attempts.evaluationId });
  for (const row of closed) {
    events.attemptClosed(
      row.evaluationId,
      { id: row.id } as AttemptRecord,
      "server",
      now,
    );
  }
  // An exercise with retakes grades each attempt as it ends (ADR-025), the
  // ones time ran out on included: the student reads that score next.
  if (app) {
    const byEvaluation = new Map<string, string[]>();
    for (const row of closed) {
      byEvaluation.set(row.evaluationId, [...(byEvaluation.get(row.evaluationId) ?? []), row.id]);
    }
    for (const [evaluationId, ids] of byEvaluation) {
      const evaluation = await byId(db, evaluationId);
      if (evaluation) await gradeFinishedRetakes(app, evaluation, ids);
    }
  }
  return closed;
}

/** Step 2: `scheduled → lobby` (or straight to `running` when lobby is skipped). */
export async function autoOpenScheduled(db: Db, now: Date): Promise<EvaluationRecord[]> {
  const due = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.state, "scheduled"),
        isNotNull(evaluations.opensAt),
        lte(evaluations.opensAt, now),
      ),
    );
  const moved: EvaluationRecord[] = [];
  for (const row of due) {
    const settings = settingsOf(row);
    const next =
      settings.lobby === "skip"
        ? await startEvaluation(db, row, now)
        : await applyState(db, row, "lobby", now);
    if (settings.lobby !== "skip") events.stateChanged(next, now);
    moved.push(next);
  }
  return moved;
}

/** Step 3: `lobby` + `lobby: auto` + everybody present → `running`. */
export async function autoStartFullLobbies(db: Db, now: Date): Promise<EvaluationRecord[]> {
  // `lobby` absent from the jsonb means its default, "manual": the SQL
  // predicate and `settingsOf(row).lobby === "auto"` select the same rows.
  const rows = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.state, "lobby"), sql`${evaluations.settings} ->> 'lobby' = 'auto'`));
  // An empty room never starts, so only an occupied lobby is worth counting.
  const occupied = rows.filter((row) => presence.count(row.id) > 0);
  const enrolledOf = await enrolledCounts(db, occupied);
  const moved: EvaluationRecord[] = [];
  for (const row of occupied) {
    const enrolled = enrolledOf.get(row.id) ?? 0;
    if (enrolled === 0 || presence.count(row.id) < enrolled) continue;
    moved.push(await startEvaluation(db, row, now));
  }
  return moved;
}

/**
 * When the ticker may close an evaluation: the last deadline anybody holds,
 * plus the grace of the autosave gate (D12). An accommodation and every
 * `+1/+5/+10 min` push an attempt past `closes_at`, and closing on
 * `closes_at` alone would take those minutes straight back (F-ORG-07).
 */
function autoCloseAt(closesAt: Date, latestAttemptDeadline: Date | null): Date {
  const last =
    latestAttemptDeadline !== null && latestAttemptDeadline.getTime() > closesAt.getTime()
      ? latestAttemptDeadline
      : closesAt;
  return new Date(last.getTime() + GRACE_MS);
}

/**
 * Step 4: `running` past `closes_at` → `closed` (+ enqueue grading).
 *
 * A `paused` evaluation is left alone: time stands still while it is
 * paused, and the resume moves `closes_at` (in `deadline` timing) and every
 * open deadline forward by the pause. Only the teacher closes a paused
 * evaluation (#77).
 */
export async function autoCloseDue(
  db: Db,
  now: Date,
  app?: FastifyInstance,
): Promise<EvaluationRecord[]> {
  const due = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.state, "running"),
        isNotNull(evaluations.closesAt),
        lte(evaluations.closesAt, now),
      ),
    );
  if (due.length === 0) return [];
  // Step 1 expired everything whose own deadline has passed, so what is
  // still `in_progress` here is a student who genuinely has time left.
  const latest = await db
    .select({ evaluationId: attempts.evaluationId, deadlineAt: max(attempts.deadlineAt) })
    .from(attempts)
    .where(
      and(
        inArray(attempts.evaluationId, due.map((row) => row.id)),
        eq(attempts.state, "in_progress"),
        isNotNull(attempts.deadlineAt),
      ),
    )
    .groupBy(attempts.evaluationId);
  const latestOf = new Map(latest.map((l) => [l.evaluationId, l.deadlineAt]));
  const moved: EvaluationRecord[] = [];
  for (const row of due) {
    const last = latestOf.get(row.id) ?? null;
    if (autoCloseAt(row.closesAt!, last).getTime() > now.getTime()) continue;
    moved.push(await closeEvaluation(db, row, now, "server", app));
  }
  return moved;
}

/** Step 5: connections silent for too long stop counting as present. */
export function sweepPresence(now: Date, idleMs: number): void {
  for (const change of presence.sweep(now, idleMs)) {
    events.presenceChanged(change.evaluationId, change.userId, change.online, change.lastSeenAt);
  }
}
