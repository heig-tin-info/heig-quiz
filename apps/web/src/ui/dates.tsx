import type { DateFormat } from "@quiz/contracts";

import { useI18n, useT } from "../i18n";
import { cx, Tip, useNow } from "./layers";

// Dates: the account's date format, absolute and relative times.

/** Account preference adopted in App.tsx; module-level on purpose — date
    formatting is plain string work, every view re-renders through the `me`
    query when the preference changes. */
let dateFormat: DateFormat = "iso";
export function setDateFormat(f: DateFormat | null | undefined) {
  dateFormat = f ?? "iso";
}

/** The date and the time of a moment, apart, in an explicit format. */
function datePartsAs(iso: string, f: DateFormat): { date: string; time: string } {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const [Y, M, D] = [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())];
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  switch (f) {
    case "eu":
      return { date: `${D}.${M}.${Y}`, time: hm };
    case "uk":
      return { date: `${D}/${M}/${Y}`, time: hm };
    case "us":
      return {
        date: `${M}/${D}/${Y}`,
        time: `${d.getHours() % 12 || 12}:${p(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`,
      };
    default:
      return { date: `${Y}-${M}-${D}`, time: hm };
  }
}

/** A date-time in an explicit format (used by the settings preview). */
export function formatDateTimeAs(iso: string, f: DateFormat): string {
  const { date, time } = datePartsAs(iso, f);
  return `${date} ${time}`;
}

/** Local date-time in the user's preferred format; ISO `2026-09-01 08:00` by default. */
/** The browser's time zone: where the reader's day begins and ends, and what a `datetime-local` means. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isoDateTime(iso: string): string {
  return formatDateTimeAs(iso, dateFormat);
}

/**
 * The same moment as {@link isoDateTime}, date and time apart, for a sentence
 * that puts a word between them ("Started on {date} at {time}").
 */
export function isoDateParts(iso: string): { date: string; time: string } {
  return datePartsAs(iso, dateFormat);
}

/**
 * A share, 0 to 1, as a whole percentage in the interface language: "85%",
 * "85 %". Beside the date formats because it is the same kind of thing — a
 * number written the way the reader's language writes it.
 */
export function percent(rate: number, locale: "en" | "fr"): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(rate);
}

/**
 * "30 minutes ago", "il y a 2 jours", "in 3 hours" — `Intl.RelativeTimeFormat`
 * in the interface language, with the largest unit that is not zero. Under a
 * minute it is "just now" (a key, since Intl has no word for it). Pure, so
 * it is testable; the component below feeds it the clock.
 */
export function relativeTime(
  iso: string,
  now: number,
  locale: "en" | "fr",
  t: (key: "time.now") => string,
): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return t("time.now");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["week", 7 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return t("time.now");
}

/**
 * A date as a distance ("an hour ago"), the full local date-time in a `Tip`
 * on hover and focus, and the machine-readable value in `<time>`. This is
 * how a date is written anywhere a teacher scans a list: the distance is
 * what they compare, the exact stamp is one hover away. Re-renders once a
 * minute so "just now" ages without a reload.
 */
export function RelativeTime({ iso, className = "" }: { iso: string; className?: string }) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(60_000);
  return (
    <Tip label={isoDateTime(iso)}>
      <time dateTime={iso} tabIndex={0} className={cx("tabular-nums", className)}>
        {relativeTime(iso, now, locale, t)}
      </time>
    </Tip>
  );
}

/** "labo-02-quadratic" → "Labo 02 Quadratic" (default assignment/classroom name). */
export function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
