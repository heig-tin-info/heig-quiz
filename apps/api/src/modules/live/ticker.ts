/**
 * The ticker tasks (§5.3): expire, auto-open, auto-start, auto-close and
 * the presence sweep. Each is one idempotent pass driven by the server's
 * clock (invariant 5). Imported through `./service.ts`.
 */
import type { FastifyInstance } from "fastify";

import { and, count, eq, inArray, isNotNull, lte, max, notInArray, sql, type SQL } from "drizzle-orm";
import { GRACE_MS } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, evaluations } from "../../db/schema.js";
import { applyState, byId, pastTimingOf, settingsOf, type EvaluationRecord } from "../evaluation/service.js";
import { endAttempts, seated } from "./dwell.js";
import { endKioskSessions } from "../../auth/session.js";
import * as events from "./events.js";
import { presence } from "../realtime/presence.js";
import { type AttemptRecord, enrolledCounts, gradeAtHandIn } from "./attempt.js";
import { startEvaluation, closeEvaluation } from "./control.js";

// --- Ticker tasks (§5.3) --------------------------------------------------

/**
 * The attempts step 1 ends at `now` (with `in_progress`, which `endAttempts`
 * adds): their OWN deadline — accommodation, extensions, retakes, reopenings
 * and pauses are all already in `deadline_at` — plus the grace has passed,
 * and their evaluation is not paused. The one definition, shared with the
 * system status, which asks it about a minute ago (`overdueAttempts`).
 */
function dueAttempts(db: Db, now: Date): SQL {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  return and(
    isNotNull(attempts.deadlineAt),
    lte(attempts.deadlineAt, cutoff),
    notInArray(
      attempts.evaluationId,
      db.select({ id: evaluations.id }).from(evaluations).where(eq(evaluations.state, "paused")),
    ),
  )!;
}

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
  // Their question on screen is credited up to the deadline, which the
  // flush clamps at (ADR-039).
  const closed = await endAttempts(db, dueAttempts(db, now), { state: "expired", closedBy: "server" }, now);
  for (const row of closed) {
    events.attemptClosed(
      row.evaluationId,
      { id: row.id } as AttemptRecord,
      "server",
      now,
    );
  }
  // ADR-051 §7: their stations go back to pairing, after the frames above.
  for (const evaluationId of new Set(closed.map((row) => row.evaluationId))) {
    await endKioskSessions(db, evaluationId, seated(closed.filter((row) => row.evaluationId === evaluationId)));
  }
  // An exercise grades each attempt as it ends (ADR-067), the ones time ran
  // out on included: the student reads that score next.
  if (app) {
    const byEvaluation = new Map<string, string[]>();
    for (const row of closed) {
      byEvaluation.set(row.evaluationId, [...(byEvaluation.get(row.evaluationId) ?? []), row.id]);
    }
    for (const [evaluationId, ids] of byEvaluation) {
      const evaluation = await byId(db, evaluationId);
      if (evaluation) await gradeAtHandIn(app, evaluation, ids);
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
    // A common end already past (#178): opening would close it at the next
    // pass, with nobody having sat it. It stays scheduled, where the launch
    // step says so and the teacher can take it back to draft.
    if (pastTimingOf(row, settings.lobby === "skip" ? "running" : "lobby", now)) continue;
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
    // Past its common end (#178), it waits for the teacher's "+N min".
    if (pastTimingOf(row, "running", now)) continue;
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
 * Step 4: `running` past `closes_at` → `closed` (+ enqueue grading),
 * whatever the timing: a common end, the end of a `duration` window, or a
 * live evaluation's safety deadline (`manual`, ADR-086 §2) alike.
 *
 * A `paused` evaluation is left alone: time stands still while it is
 * paused, and the resume moves `closes_at` (in `deadline` timing, and
 * `manual` with a safety deadline) and every
 * open deadline forward by the pause. Only the teacher closes a paused
 * evaluation (#77).
 */
export async function autoCloseDue(
  db: Db,
  now: Date,
  app?: FastifyInstance,
): Promise<EvaluationRecord[]> {
  const moved: EvaluationRecord[] = [];
  for (const row of await dueToClose(db, now)) {
    moved.push(await closeEvaluation(db, row, now, "server", app));
  }
  return moved;
}

/**
 * The evaluations step 4 closes at `now`: `running`, past `closes_at`, and
 * past the last deadline anybody still holds, plus the grace
 * (`autoCloseAt`). Shared with the system status (`overdueEvaluations`).
 */
async function dueToClose(db: Db, now: Date): Promise<EvaluationRecord[]> {
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
  return due.filter(
    (row) => autoCloseAt(row.closesAt!, latestOf.get(row.id) ?? null).getTime() <= now.getTime(),
  );
}

/**
 * What the ticker should have done `marginMs` ago and has not (N-OPS-03):
 * the same predicates as steps 1 and 4, asked about `now - marginMs`, so
 * the system status can never disagree with the ticker about what is due —
 * only notice that it has not run. Counts only, never who.
 */
export async function overdueAttempts(db: Db, now: Date, marginMs: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(attempts)
    .where(and(eq(attempts.state, "in_progress"), dueAttempts(db, new Date(now.getTime() - marginMs))));
  return row?.n ?? 0;
}

/** Evaluations still `running` past the moment step 4 closes them (see above). */
export async function overdueEvaluations(db: Db, now: Date, marginMs: number): Promise<number> {
  return (await dueToClose(db, new Date(now.getTime() - marginMs))).length;
}

/** Step 5: connections silent for too long stop counting as present. */
export function sweepPresence(now: Date, idleMs: number): void {
  for (const change of presence.sweep(now, idleMs)) {
    events.presenceChanged(change.evaluationId, change.userId, change.online, change.lastSeenAt);
  }
}
