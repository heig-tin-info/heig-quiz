/**
 * The dwell (ADR-039): how long each question stays on a student's screen,
 * measured on the SERVER's clock from the position reports of the player.
 * Imported through `./service.ts`.
 *
 * An attempt holds at most one open interval — `shown_item_id` since
 * `shown_since` — and {@link closeShown} is the one place an interval ends:
 * it credits the item's `answers.dwell_ms` and clears the pair. Every end of
 * an interval goes through it — the next report, the pause, and every end of
 * an attempt through {@link endAttempts} (the submission, the close of the
 * attempt or of the evaluation, the expiry by the ticker) — so the
 * arithmetic lives in one statement.
 *
 * What an interval is credited, in milliseconds:
 *
 *     max(0, min(end, deadline_at, max(since, answers.updated_at) + CAP) - since)
 *
 *   - `end` is the server's instant of the signal that closes it (invariant 5);
 *   - the DEADLINE clamps it: the grace window is for the network, not
 *     thinking time, and a manual timing (no deadline) has no clamp;
 *   - the IDLE CAP (`DWELL_IDLE_CAP_MS`) bounds a question left on screen in
 *     a forgotten tab: an interval counts at most that long after the later of
 *     its start and the student's last write to the question. The autosave
 *     already stamps `answers.updated_at`, so the cap costs the hot path no
 *     write, and this flush never touches `updated_at` itself.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { ClosedBy } from "@quiz/contracts";
import { DWELL_IDLE_CAP_MS } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts } from "../../db/schema.js";

/** An attempt {@link endAttempts} ended: what a listener needs, read in the same statement. */
export interface EndedAttempt {
  id: string;
  evaluationId: string;
  userId: string | null;
}

/** The accounts of ended attempts (a guest's has none): whose `kiosk` sessions end with them (ADR-051 §7). */
export const seated = (ended: readonly EndedAttempt[]): string[] =>
  ended.flatMap((a) => (a.userId === null ? [] : [a.userId]));

type EndedListener = (db: Db, ended: readonly EndedAttempt[], now: Date) => Promise<unknown>;
const endedListeners = new Set<EndedListener>();

/**
 * Called after every commit of {@link endAttempts} that ended something.
 * The `drill` module registers here (ADR-041 §1: the hand-in of an exercise
 * is when its questions become cards), so that `live` never imports it —
 * the dependency goes one way, drill on live. A listener that throws is
 * logged and ignored: the attempt is over whatever it makes of it.
 */
export function onAttemptsEnded(listener: EndedListener): void {
  endedListeners.add(listener);
}

/** The attempts of an evaluation still being taken. */
export function openAttemptsOf(evaluationId: string): SQL {
  return and(eq(attempts.evaluationId, evaluationId), eq(attempts.state, "in_progress"))!;
}

/**
 * Ends the open interval of every attempt `which` selects, at `end`, and
 * credits it to the item it was on. ONE statement: the attempts are locked
 * (in id order, so two bulk closes cannot deadlock each other), cleared, and
 * their answers credited — the lock order every caller shares is the
 * attempt row first, the answer row after.
 *
 * `which` is a condition on `attempts`; an attempt with nothing on screen is
 * left untouched.
 */
export async function closeShown(db: Db, which: SQL, end: Date): Promise<void> {
  const at = sql`${end.toISOString()}::timestamptz`;
  await db.execute(sql`
    with closed as (
      update attempts a
         set shown_item_id = null, shown_since = null
        from (select id, shown_item_id, shown_since, deadline_at
                from attempts
               where ${which} and shown_item_id is not null
               order by id
                 for update) old
       where a.id = old.id
      returning old.id as attempt_id, old.shown_item_id as item_id,
                old.shown_since as since, old.deadline_at as deadline_at
    )
    update answers ans
       set dwell_ms = ans.dwell_ms + greatest(0, floor(extract(epoch from (
             least(${at}, coalesce(c.deadline_at, ${at}),
                   greatest(c.since, ans.updated_at) + make_interval(secs => ${DWELL_IDLE_CAP_MS / 1000}))
             - c.since)) * 1000))::int
      from closed c
     where ans.attempt_id = c.attempt_id and ans.item_id = c.item_id`);
}

/**
 * Ends every `in_progress` attempt `which` selects — a submission, a
 * teacher's close, the close of an evaluation, the ticker's expiry — in ONE
 * transaction: the rows are locked in id order (the order every bulk writer
 * of `attempts` shares, so two of them cannot deadlock), their open interval
 * is credited, then their state is written. Answers the attempts it ended;
 * one already finished is left alone.
 *
 * What it ended is then handed to the {@link onAttemptsEnded} listeners,
 * after the commit.
 */
export async function endAttempts(
  db: Db,
  which: SQL,
  set: { state: "submitted" | "expired"; closedBy: ClosedBy; submittedAt?: Date },
  now: Date,
): Promise<EndedAttempt[]> {
  const ended = await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(which, eq(attempts.state, "in_progress")))
      .orderBy(attempts.id)
      .for("update");
    if (locked.length === 0) return [];
    const ids = inArray(attempts.id, locked.map((row) => row.id));
    await closeShown(tx, ids, now);
    return tx
      .update(attempts)
      .set({ ...set, closedAt: now, updatedAt: now })
      .where(ids)
      .returning({
        id: attempts.id,
        evaluationId: attempts.evaluationId,
        userId: attempts.userId,
      });
  });
  if (ended.length > 0) {
    for (const listener of endedListeners) {
      try {
        await listener(db, ended, now);
      } catch (err) {
        // The service layer has no logger (as `results/service.ts`): stderr.
        console.error("live: an attempts-ended listener failed", err);
      }
    }
  }
  return ended;
}
