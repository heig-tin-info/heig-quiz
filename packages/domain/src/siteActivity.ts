/**
 * The platform's activity as the administrator sees it (ADR-107): how many
 * people used it, at which hours of the last seven days, and how much of the
 * students' activity fell outside class hours.
 *
 * The unit is the PERSON-HOUR: one person active at least once in one local
 * hour. The server records it (`presence_hours`), the database groups it by
 * the local hour of the school's time zone (`SCHOOL_TIME_ZONE`); what is left
 * here is pure — the class-hours window, the days the grid shows, and the
 * off-hours share.
 */
/**
 * Class hours (owner, 2026-10-12): Monday to Friday, from `weekdayStart`
 * included to `weekdayEnd` excluded, local time. Fixed, not a setting: the
 * figure it produces is a rough reading of usage, not a timetable.
 */
export const CLASS_HOURS = { weekdayStart: 8, weekdayEnd: 18 } as const;

/** Days of hourly rows kept: the seven of the grid, and one of margin for a late purge. */
export const PRESENCE_RETENTION_DAYS = 8;

/** Days the grid shows, today included. */
export const ACTIVITY_DAYS = 7;

/** "Active now": seen by the server within these minutes. */
export const ACTIVE_NOW_MINUTES = 15;

const DAY_MS = 86_400_000;

/** The weekday of a calendar date `YYYY-MM-DD`: 0 on a Sunday … 6 on a Saturday. */
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * Whether the local hour `hour` (0–23) of a weekday is a class hour; the
 * weekday counts from Monday, 0, to Sunday, 6 — the rows of a week's grid.
 */
export function isWeekdayClassHour(weekday: number, hour: number): boolean {
  return weekday >= 0 && weekday <= 4 && hour >= CLASS_HOURS.weekdayStart && hour < CLASS_HOURS.weekdayEnd;
}

/** Whether the local hour `hour` (0–23) of the calendar date `date` is a class hour. */
export function isClassHour(date: string, hour: number): boolean {
  return isWeekdayClassHour((weekdayOf(date) + 6) % 7, hour);
}

/** The `ACTIVITY_DAYS` calendar dates that end on `today` (`YYYY-MM-DD`), oldest first. */
export function datesEndingOn(today: string): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: ACTIVITY_DAYS }, (_, i) =>
    new Date(end - (ACTIVITY_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * The share (0–1) of a grid's figures — rows of 24 hourly counts — that fall
 * outside class hours, as `isClassHour(row, hour)` decides for the grid's
 * rows (dated days for the platform, ADR-107; weekdays for the drill,
 * ADR-041 §8); null when the grid holds nothing. The unit is the grid's own.
 */
export function offHoursShare(
  rows: readonly (readonly number[])[],
  isClassHour: (row: number, hour: number) => boolean,
): number | null {
  let all = 0;
  let outside = 0;
  rows.forEach((hours, row) =>
    hours.forEach((n, hour) => {
      all += n;
      if (!isClassHour(row, hour)) outside += n;
    }),
  );
  return all === 0 ? null : outside / all;
}
