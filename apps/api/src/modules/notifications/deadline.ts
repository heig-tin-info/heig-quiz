/**
 * `deadline_approaching` (ADR-030, addendum §d): 24 hours before an
 * evaluation's common end, each student of its classroom who has not
 * submitted is reminded, once. A scan of the ticker — the server owns the
 * clock (invariant 5) — and not a timer: a restart or a missed tick is
 * caught up by the next pass, since the condition stays true until the
 * evaluation closes.
 *
 * A pair (evaluation, student) is due when ALL of these hold:
 *   - the evaluation is `running` (not paused, not closed), not a poll, and
 *     has a `closes_at`, whatever its timing mode;
 *   - `closes_at - 24 h <= now < closes_at`: the reminder is never sent for
 *     an end already past (an evaluation left running past `closes_at` by
 *     an accommodation or a "+N min" is closing, not approaching);
 *   - `started_at <= closes_at - 24 h`: a window shorter than a day (a
 *     two-hour exam, a ten-minute exercise) gets no reminder;
 *   - the student holds a CLAIMED, non-staff seat of the classroom;
 *   - the student has NO FINISHED attempt (`submitted` or `expired`): no
 *     attempt at all, or one not started or in progress. With retakes
 *     (F-EVAL-15), a student who has submitted once has something that
 *     counts and is not reminded, even if a retake is open;
 *   - no marker exists yet in `deadline_reminders`.
 *
 * Individual extensions (accommodation, a "+N min" to one student) are
 * ignored: the reminder is keyed on the common `closes_at` alone.
 *
 * The claim IS the selection: one `INSERT … SELECT … ON CONFLICT DO NOTHING
 * RETURNING` writes the markers of every due pair, and only the pairs it
 * returns are notified. Two concurrent scans therefore tell a student once,
 * and a `closes_at` moved after the reminder finds the marker and tells
 * nobody again. Best-effort: a notification that fails is logged, its
 * markers stay (not retried), and the scan never throws at the ticker.
 */
import { and, eq, inArray, isNotNull, lte, gt, ne, notExists, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { attempts, deadlineReminders, enrollments, evaluations } from "../../db/schema.js";
import { notifyMany } from "./service.js";

/** How long before `closes_at` the reminder is due. Fixed: no setting (§d, §g). */
export const DEADLINE_REMINDER_MS = 24 * 3_600_000;

/** Where a failed fan-out is reported: the ticker passes `app.log`. */
export interface ReminderLog {
  error(obj: object, msg: string): void;
}

/** Outside the ticker (a script, a test), stderr. */
const stderrLog: ReminderLog = { error: (obj, msg) => console.error(msg, obj) };

/**
 * Claims and sends every reminder due at `now`. Returns the pairs this pass
 * claimed (the ones it told, or tried to).
 */
export async function sendDeadlineReminders(
  db: Db,
  now: Date,
  log: ReminderLog = stderrLog,
): Promise<{ evaluationId: string; userId: string }[]> {
  const horizon = new Date(now.getTime() + DEADLINE_REMINDER_MS);
  const due = db
    .select({
      evaluationId: evaluations.id,
      userId: sql<string>`${enrollments.userId}`.as("user_id"),
      sentAt: sql<Date>`${now.toISOString()}::timestamptz`.as("sent_at"),
    })
    .from(evaluations)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, evaluations.classroomId),
        eq(enrollments.staff, false),
        isNotNull(enrollments.userId),
      ),
    )
    .where(
      and(
        eq(evaluations.state, "running"),
        ne(evaluations.mode, "poll"),
        lte(evaluations.closesAt, horizon),
        gt(evaluations.closesAt, now),
        // A null `closes_at` or `started_at` fails these comparisons.
        sql`${evaluations.startedAt} <= ${evaluations.closesAt} - ${DEADLINE_REMINDER_MS}::bigint * interval '1 millisecond'`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(attempts)
            .where(
              and(
                eq(attempts.evaluationId, evaluations.id),
                eq(attempts.userId, enrollments.userId),
                inArray(attempts.state, ["submitted", "expired"]),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(deadlineReminders)
            .where(
              and(
                eq(deadlineReminders.evaluationId, evaluations.id),
                eq(deadlineReminders.userId, enrollments.userId),
              ),
            ),
        ),
      ),
    );
  const claimed = await db
    .insert(deadlineReminders)
    .select(due)
    .onConflictDoNothing()
    .returning({ evaluationId: deadlineReminders.evaluationId, userId: deadlineReminders.userId });
  if (claimed.length === 0) return [];

  const ids = [...new Set(claimed.map((c) => c.evaluationId))];
  const titles = new Map(
    (
      await db
        .select({ id: evaluations.id, title: evaluations.title })
        .from(evaluations)
        .where(inArray(evaluations.id, ids))
    ).map((r) => [r.id, r.title]),
  );
  // One fan-out per evaluation, so one that fails does not silence the others.
  for (const evaluationId of ids) {
    try {
      await notifyMany(
        db,
        claimed
          .filter((c) => c.evaluationId === evaluationId)
          .map((c) => ({
            userId: c.userId,
            payload: {
              kind: "deadline_approaching" as const,
              evaluationId,
              evaluationTitle: titles.get(evaluationId) ?? "",
            },
          })),
      );
    } catch (err) {
      log.error({ err, evaluationId }, "notifications: the deadline reminders failed");
    }
  }
  return claimed;
}
