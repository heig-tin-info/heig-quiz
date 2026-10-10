/**
 * The calendar of the festive touches (ADR-092): which day dresses the logo.
 * It is the only part of them always loaded; the drawings (`art.ts`) are a
 * chunk fetched on a festive day only. Dates are the browser's: a costume is
 * cosmetic, never a deadline (invariant 5 binds deadlines, not decoration).
 */

/** A day of a given year: the first or the last of a period (a `to` before its `from` wraps into January). */
type Rule = (year: number) => Date;

const day =
  (month: number, date: number): Rule =>
  (year) =>
    new Date(year, month - 1, date);

const shift =
  (rule: Rule, days: number): Rule =>
  (year) => {
    const d = rule(year);
    d.setDate(d.getDate() + days);
    return d;
  };

/** Easter Sunday in the Gregorian calendar (the Meeus/Jones/Butcher algorithm). */
export function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return new Date(year, Math.floor(n / 31) - 1, (n % 31) + 1);
}

/** Ada Lovelace Day: the second Tuesday of October. */
const adaDay: Rule = (year) => {
  const weekday = new Date(year, 9, 1).getDay();
  return new Date(year, 9, 1 + ((9 - weekday) % 7) + 7);
};

/** Programmers' Day: the 256th day of the year (13 September, 12 in a leap year). */
const day256: Rule = (year) => new Date(year, 0, 256);

const once = (rule: Rule) => ({ from: rule, to: rule });

/** The festive days, in the order of the academic year. */
export const FESTIVE = [
  { id: "programmers", ...once(day256) },
  { id: "ada", ...once(adaDay) },
  { id: "hopper", ...once(day(12, 9)) },
  { id: "xmas", from: day(12, 15), to: day(1, 6) },
  { id: "torvalds", ...once(day(12, 28)) },
  { id: "kernighan", ...once(day(1, 30)) },
  { id: "pi", ...once(day(3, 14)) },
  {
    id: "easter",
    from: shift(easter, -2),
    to: shift(easter, 1),
  },
  { id: "starwars", ...once(day(5, 4)) },
  { id: "turing", ...once(day(6, 23)) },
] as const satisfies readonly { id: string; from: Rule; to: Rule }[];

export type FestiveId = (typeof FESTIVE)[number]["id"];

/**
 * The festive day of a date, or null. Several periods may hold it (Linus
 * Torvalds's birthday falls within Christmas): the shortest wins.
 */
export function festiveOn(date: Date): FestiveId | null {
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let best: { id: FestiveId; length: number } | null = null;
  for (const festive of FESTIVE) {
    for (const year of [midnight.getFullYear() - 1, midnight.getFullYear()]) {
      const from = festive.from(year);
      const to = festive.to(year) < from ? festive.to(year + 1) : festive.to(year);
      const length = to.getTime() - from.getTime();
      if (midnight >= from && midnight <= to && (!best || length < best.length)) best = { id: festive.id, length };
    }
  }
  return best?.id ?? null;
}
