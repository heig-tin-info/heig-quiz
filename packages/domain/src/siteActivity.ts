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

/** Whether the local hour `hour` (0–23) of the calendar date `date` is a class hour. */
export function isClassHour(date: string, hour: number): boolean {
  const day = weekdayOf(date);
  return day >= 1 && day <= 5 && hour >= CLASS_HOURS.weekdayStart && hour < CLASS_HOURS.weekdayEnd;
}

/** The `ACTIVITY_DAYS` calendar dates that end on `today` (`YYYY-MM-DD`), oldest first. */
export function datesEndingOn(today: string): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: ACTIVITY_DAYS }, (_, i) =>
    new Date(end - (ACTIVITY_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** One day of the grid, as far as the share needs it: 24 hours of student counts. */
export interface StudentHours {
  date: string;
  hours: readonly { students: number }[];
}

/**
 * The share (0–1) of the students' person-hours of `days` that fall outside
 * class hours; null when there is none to share.
 */
export function offHoursStudentShare(days: readonly StudentHours[]): number | null {
  let all = 0;
  let outside = 0;
  for (const day of days) {
    day.hours.forEach((cell, hour) => {
      all += cell.students;
      if (!isClassHour(day.date, hour)) outside += cell.students;
    });
  }
  return all === 0 ? null : outside / all;
}
