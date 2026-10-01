/**
 * The student's "Coming up" as an agenda (product owner, 2026-10-01): each
 * row filed under Today, Tomorrow, This week or Later, by the calendar day of
 * one instant in a given time zone (the browser's, on the web).
 *
 *   - `today`    — the same calendar day as `now`, or earlier: a scheduled
 *                  activity whose opening has just passed is still today's
 *                  business until the ticker opens it;
 *   - `tomorrow` — the next calendar day, even when it is next week's Monday;
 *   - `week`     — after tomorrow, up to the Sunday that ends `now`'s ISO
 *                  week (weeks start on Monday). Empty from Saturday on;
 *   - `later`    — anything after that, and a row with no date at all.
 *
 * Pure: the instant and the time zone are the caller's.
 */
import { zoneOffset } from "./zone.js";

export type DayBucket = "today" | "tomorrow" | "week" | "later";

/** The order the buckets are drawn in. */
const DAY_BUCKETS: readonly DayBucket[] = ["today", "tomorrow", "week", "later"];

const DAY = 86_400_000;

/** The calendar day of `at` in `timeZone`, as a count of days since 1970-01-01. */
const civilDay = (at: number, timeZone: string): number =>
  Math.floor((at + zoneOffset(new Date(at), timeZone)) / DAY);

/** Days since the Monday of its week: 0 on a Monday, 6 on a Sunday (1970-01-01 was a Thursday). */
const isoWeekday = (day: number): number => (((day + 3) % 7) + 7) % 7;

const parse = (at: string | null): number => {
  const ms = at === null ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? Infinity : ms;
};

/** The bucket of the instant `ms` (Infinity for undated) on the calendar day `today`. */
function bucketOn(ms: number, today: number, timeZone: string): DayBucket {
  if (ms === Infinity) return "later";
  const diff = civilDay(ms, timeZone) - today;
  if (diff <= 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff <= 6 - isoWeekday(today)) return "week";
  return "later";
}

/** The bucket of the instant `at` (ISO string; null for undated) seen at `now` in `timeZone`. */
export function dayBucket(at: string | null, now: number, timeZone: string): DayBucket {
  return bucketOn(parse(at), civilDay(now, timeZone), timeZone);
}

/**
 * The rows grouped by {@link dayBucket}, in bucket order, the empty buckets
 * left out. Inside a bucket, the soonest first; the undated last; ties keep
 * the input's order.
 */
export function groupByDay<T>(
  rows: readonly T[],
  at: (row: T) => string | null,
  now: number,
  timeZone: string,
): { bucket: DayBucket; rows: T[] }[] {
  const today = civilDay(now, timeZone);
  const placed = rows.map((row) => {
    const ms = parse(at(row));
    return { row, ms, bucket: bucketOn(ms, today, timeZone) };
  });
  // `Array.prototype.sort` is stable.
  placed.sort((a, b) => (a.ms === b.ms ? 0 : a.ms < b.ms ? -1 : 1));
  return DAY_BUCKETS.map((bucket) => ({
    bucket,
    rows: placed.filter((p) => p.bucket === bucket).map((p) => p.row),
  })).filter((group) => group.rows.length > 0);
}
