/**
 * The dwell (ADR-039): how long each question stays on a student's screen,
 * measured on the SERVER's clock from the position reports of the player.
 * Imported through `./service.ts`.
 *
 * An attempt holds at most one open interval — `shown_item_id` since
 * `shown_since` — and {@link closeShown} is the one place an interval ends:
 * it credits the item's `answers.dwell_ms` and clears the pair. Every end of
 * an interval goes through it — the next report, the submission, the close
 * of the attempt or of the evaluation, the pause, the expiry by the ticker —
 * so the arithmetic lives in one statement.
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
import { sql, type SQL } from "drizzle-orm";

import { DWELL_IDLE_CAP_MS } from "@quiz/domain";

import type { Db } from "../../db/client.js";

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
export async function closeShown(db: Db, which: SQL | undefined, end: Date): Promise<void> {
  const at = sql`${end.toISOString()}::timestamptz`;
  await db.execute(sql`
    with closed as (
      update attempts a
         set shown_item_id = null, shown_since = null
        from (select id, shown_item_id, shown_since, deadline_at
                from attempts
               where ${which ?? sql`true`} and shown_item_id is not null
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
