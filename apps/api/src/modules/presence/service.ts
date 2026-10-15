/**
 * The platform's activity (F-ADMIN-09, ADR-107): which hours each person used
 * it, and when they were last seen — recorded on the person's own requests,
 * read by the administrator in aggregate only.
 *
 * The module owns `presence_hours` and `presence_last_seen`
 * (`db/presence.ts`) and is their one writer. What counts as activity is
 * decided where the session is resolved (`auth/plugin.ts`): the person's own
 * `portal`, `seb` or `kiosk` session on a route that is not background
 * traffic, never an impersonation, a bearer token or a request the SPA marked
 * idle.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";

import type { AdminActivity } from "@quiz/contracts";
import {
  ACTIVE_NOW_MINUTES,
  PRESENCE_RETENTION_DAYS,
  datesEndingOn,
  isClassHour,
  localDate,
  offHoursShare,
  SCHOOL_TIME_ZONE,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { presenceHours, presenceLastSeen, users } from "../../db/schema.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A person's last activity moves at most this often: "active now" needs no finer grain. */
const SEEN_EVERY_MS = 5 * 60_000;
/** How long the recorder gathers rows before writing them in one statement per table. */
export const FLUSH_EVERY_MS = 3_000;

/**
 * The recorder of one process. What it already queued is its dedupe: a person
 * costs at most one hour row an hour and one last-seen row every five
 * minutes, and the rows of everybody are written together every few seconds —
 * the start of an exam is two statements, not one per student.
 */
export interface PresenceRecorder {
  /** Notes a request of `userId`'s own session at `now`; never awaited by the request, never throws. */
  touch: (userId: string, now: Date) => void;
  /** Writes what is queued and resolves once every write has ended (tests, shutdown). */
  settled: () => Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The process's recorder of activity (ADR-107), fed by `auth/plugin.ts`. */
    sitePresence: PresenceRecorder;
  }
}

/**
 * The per-process recorder. Another process, or a restart, may write a row
 * once more: `ON CONFLICT DO NOTHING` keeps the hour row single, and the
 * last-seen upsert only ever moves forward (`GREATEST`). A batch that fails
 * is logged and its rows forgotten from the dedupe, so the next request of
 * the same person queues them again.
 */
export function createPresenceRecorder(
  db: Db,
  log: FastifyBaseLogger,
  flushEveryMs: number = FLUSH_EVERY_MS,
): PresenceRecorder {
  const recordedHour = new Map<string, number>();
  const seenAt = new Map<string, number>();
  let hours = new Map<string, { userId: string; hour: Date }>();
  let seen = new Map<string, { userId: string; at: Date }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function write(
    batchHours: { userId: string; hour: Date }[],
    batchSeen: { userId: string; at: Date }[],
  ): Promise<void> {
    try {
      if (batchHours.length > 0) await db.insert(presenceHours).values(batchHours).onConflictDoNothing();
    } catch (err) {
      for (const row of batchHours) recordedHour.delete(row.userId);
      log.error({ err, rows: batchHours.length }, "recording the hours of activity failed");
    }
    try {
      if (batchSeen.length > 0) {
        await db
          .insert(presenceLastSeen)
          .values(batchSeen)
          .onConflictDoUpdate({
            target: presenceLastSeen.userId,
            set: { at: sql`GREATEST(${presenceLastSeen.at}, excluded.at)` },
          });
      }
    } catch (err) {
      for (const row of batchSeen) seenAt.delete(row.userId);
      log.error({ err, rows: batchSeen.length }, "recording the last activity failed");
    }
  }

  /** Hands what is queued to the writer, after the batch before it. */
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batchHours = [...hours.values()];
    const batchSeen = [...seen.values()];
    hours = new Map();
    seen = new Map();
    writing = writing.then(() => write(batchHours, batchSeen));
    return writing;
  };

  return {
    touch(userId, now) {
      try {
        const at = now.getTime();
        const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
        if (recordedHour.get(userId) !== hour) {
          recordedHour.set(userId, hour);
          hours.set(`${userId} ${hour}`, { userId, hour: new Date(hour) });
        }
        const last = seenAt.get(userId);
        if (last === undefined || at - last >= SEEN_EVERY_MS) {
          seenAt.set(userId, at);
          seen.set(userId, { userId, at: now });
        }
        if (timer === null && (hours.size > 0 || seen.size > 0)) {
          timer = setTimeout(() => void flush(), flushEveryMs);
          timer.unref?.();
        }
      } catch (err) {
        log.error({ err }, "queueing the activity failed");
      }
    },
    settled: () => flush(),
  };
}

/** The scheduled task `presence.purge`: the hours older than the retention. Returns how many went. */
export async function purgePresence(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(presenceHours)
    .where(lt(presenceHours.hour, new Date(now.getTime() - PRESENCE_RETENTION_DAYS * DAY_MS)))
    .returning({ hour: presenceHours.hour });
  return gone.length;
}

/**
 * One person's own rows (ADR-107 §7, ADR-112 §2): the hours still kept,
 * oldest first, and their last activity. For their personal data export
 * only; nobody else reads a person's hours.
 */
export async function ownActivity(db: Db, userId: string): Promise<{ hours: string[]; lastActiveAt: string | null }> {
  const hours = await db
    .select({ hour: presenceHours.hour })
    .from(presenceHours)
    .where(eq(presenceHours.userId, userId))
    .orderBy(presenceHours.hour);
  const [last] = await db
    .select({ at: presenceLastSeen.at })
    .from(presenceLastSeen)
    .where(eq(presenceLastSeen.userId, userId));
  return { hours: hours.map((h) => h.hour.toISOString()), lastActiveAt: last ? last.at.toISOString() : null };
}

/** Students by the stored role `student`; staff the teachers and admins — as everywhere. */
const STUDENTS = sql<number>`count(DISTINCT ${users.id}) FILTER (WHERE ${users.role} = 'student')::int`;
const STAFF = sql<number>`count(DISTINCT ${users.id}) FILTER (WHERE ${users.role} <> 'student')::int`;

/**
 * The administrator's view (`GET /app/api/admin/activity`): counts only, and
 * an anonymized account counted nowhere.
 *
 * The grid is the last seven calendar days of `SCHOOL_TIME_ZONE`, today
 * included, each hour the distinct people active in it — the database does
 * the conversion, so the two local 02:00 of the night summer time ends fold
 * into one hour and a person active in both counts once.
 */
export async function activityOverview(db: Db, now: Date): Promise<AdminActivity> {
  const local = sql`(${presenceHours.hour} AT TIME ZONE ${SCHOOL_TIME_ZONE})`;
  const dates = datesEndingOn(localDate(now));
  // A day before the first date's midnight wherever the offset stands: the
  // local-date condition beside it is the exact one.
  const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - DAY_MS);
  const inGrid = and(gte(presenceHours.hour, from), sql`${local}::date >= ${dates[0]}::date`);
  const hourNow = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;

  /** The people active in the hours `where` selects, by role, with `columns` beside. */
  const people = <T extends Record<string, SQL>>(columns: T, where: SQL | undefined) =>
    db
      .select({ ...columns, students: STUDENTS, staff: STAFF })
      .from(presenceHours)
      .innerJoin(users, eq(users.id, presenceHours.userId))
      .where(and(isNull(users.anonymizedAt), where));

  const [cells, [week], [day], [current], [oldest]] = await Promise.all([
    people(
      { date: sql<string>`to_char(${local}, 'YYYY-MM-DD')`, hour: sql<number>`extract(hour from ${local})::int` },
      inGrid,
    ).groupBy(sql`1`, sql`2`),
    people({}, inGrid),
    people({}, gte(presenceHours.hour, new Date(hourNow - 23 * HOUR_MS))),
    db
      .select({ students: STUDENTS, staff: STAFF })
      .from(presenceLastSeen)
      .innerJoin(users, eq(users.id, presenceLastSeen.userId))
      .where(
        and(
          isNull(users.anonymizedAt),
          gte(presenceLastSeen.at, new Date(now.getTime() - ACTIVE_NOW_MINUTES * 60_000)),
        ),
      ),
    db.select({ hour: sql<string | null>`min(${presenceHours.hour})` }).from(presenceHours),
  ]);

  const days = dates.map((date) => ({
    date,
    hours: Array.from({ length: 24 }, () => ({ students: 0, staff: 0 })),
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const c of cells) {
    const target = byDate.get(c.date)?.hours[c.hour];
    if (target) Object.assign(target, { students: c.students, staff: c.staff });
  }
  const none = { students: 0, staff: 0 };
  return {
    generatedAt: now.toISOString(),
    activeNow: current ?? none,
    last24h: day ?? none,
    last7d: week ?? none,
    offHoursStudentShare: offHoursShare(
      days.map((d) => d.hours.map((c) => c.students)),
      (r, h) => isClassHour(days[r]!.date, h),
    ),
    recordedSince: oldest?.hour ? localDate(new Date(oldest.hour)) : null,
    days,
  };
}
