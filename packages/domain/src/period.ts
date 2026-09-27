/**
 * The dated period of a classroom (F-ORG-03, issue #156), at month precision.
 *
 * A classroom may carry a first and a last month (`YYYY-MM`, both or
 * neither). The sidebar's flat "Classrooms" list shows a classroom while its
 * period covers today, give or take {@link PERIOD_MARGIN_MONTHS}; a classroom
 * without a period is always current. "Ended" is computed here, never
 * written: nothing is archived automatically.
 *
 * The HEIG-VD semesters, as presets:
 *
 *  - Autumn N  = September N … January N+1;
 *  - Spring N  = February N … July N.
 *
 * August belongs to no semester; the margin covers the exam and retake
 * sessions on either side.
 *
 * Pure: "today" is injected by the caller (the browser's local date for the
 * sidebar — a display rule, not a deadline).
 */

/** A month, as `YYYY-MM` — the value of an `<input type="month">`. */
export type YearMonth = string;

/** The shape of a {@link YearMonth}: four digits, a dash, a month 01–12. */
export const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * How many months a period stays current before its first and after its last
 * month: the autumn semester is visible August … February, the spring one
 * January … August (retake session included).
 */
export const PERIOD_MARGIN_MONTHS = 1;

export type Season = "autumn" | "spring";

/** One HEIG-VD semester: `autumn 2026` runs September 2026 … January 2027. */
export interface Semester {
  season: Season;
  year: number;
}

/** A dated period: its first and last month, both inclusive. */
export interface MonthRange {
  start: YearMonth;
  end: YearMonth;
}

export function isYearMonth(value: string): value is YearMonth {
  return YEAR_MONTH_PATTERN.test(value);
}

/** Months since year 0: makes month arithmetic a plain subtraction. */
function toIndex(ym: YearMonth): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
}

function fromIndex(index: number): YearMonth {
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** The month `n` months after `ym` (before, when `n` is negative). */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  return fromIndex(toIndex(ym) + n);
}

/** The month of a date, read in the LOCAL time zone of the caller. */
export function yearMonthOf(date: Date): YearMonth {
  return fromIndex(date.getFullYear() * 12 + date.getMonth());
}

/**
 * Whether a classroom's period covers `today`, with {@link PERIOD_MARGIN_MONTHS}
 * on both sides. No period (either month missing) → always current: a teacher
 * who leaves the months empty keeps archiving as the only filter.
 */
export function isCurrent(
  start: YearMonth | null,
  end: YearMonth | null,
  today: YearMonth | Date,
): boolean {
  if (start == null || end == null) return true;
  const now = toIndex(typeof today === "string" ? today : yearMonthOf(today));
  return (
    now >= toIndex(start) - PERIOD_MARGIN_MONTHS && now <= toIndex(end) + PERIOD_MARGIN_MONTHS
  );
}

/** The months a semester covers. */
export function semesterMonths(s: Semester): MonthRange {
  return s.season === "autumn"
    ? { start: `${s.year}-09`, end: `${s.year + 1}-01` }
    : { start: `${s.year}-02`, end: `${s.year}-07` };
}

/** The semester a month falls in, or `null` for August (between two semesters). */
export function semesterOf(today: YearMonth | Date): Semester | null {
  const ym = typeof today === "string" ? today : yearMonthOf(today);
  const [year, month] = ym.split("-").map(Number) as [number, number];
  if (month >= 9) return { season: "autumn", year };
  if (month === 1) return { season: "autumn", year: year - 1 };
  if (month <= 7) return { season: "spring", year };
  return null;
}

/** The semester after `s`: autumn N → spring N+1 → autumn N+1. */
export function nextSemester(s: Semester): Semester {
  return s.season === "autumn"
    ? { season: "spring", year: s.year + 1 }
    : { season: "autumn", year: s.year };
}

/**
 * The semester a classroom created today is most likely for: the one running,
 * or — in August — the one about to start. The creation form prefills it.
 */
export function currentOrNextSemester(today: YearMonth | Date): Semester {
  const ym = typeof today === "string" ? today : yearMonthOf(today);
  return semesterOf(ym) ?? { season: "autumn", year: Number(ym.slice(0, 4)) };
}

/** The semester whose months are exactly `range`, or `null` for any other period. */
export function semesterOfRange(range: MonthRange): Semester | null {
  const s = semesterOf(range.start);
  if (!s) return null;
  const months = semesterMonths(s);
  return months.start === range.start && months.end === range.end ? s : null;
}

/**
 * The period of a classroom duplicated for the next term (F-ORG-10): one
 * semester later. A period that is exactly a semester becomes the next
 * semester (autumn 2026 → spring 2027); any other period moves six months,
 * keeping its length.
 */
export function shiftSemester(range: MonthRange): MonthRange {
  const s = semesterOfRange(range);
  if (s) return semesterMonths(nextSemester(s));
  return { start: addMonths(range.start, 6), end: addMonths(range.end, 6) };
}
