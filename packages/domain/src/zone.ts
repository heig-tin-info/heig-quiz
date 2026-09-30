/**
 * The school's clock: the time zone the platform counts days and writes
 * local instants in, whatever the server's own zone is.
 */

/** Where the school is: its days, its deadlines as a person reads them. */
export const SCHOOL_TIME_ZONE = "Europe/Zurich";

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms (whole seconds). */
export function zoneOffset(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * An instant as ISO 8601 with the school's offset, to the second:
 * `2026-07-03T23:59:00+02:00`. What a text written into GitHub carries (a
 * deadline commit message, a workflow input), so that a reader sees the
 * school's local time and a program still reads the exact instant.
 */
export function zonedIso(at: Date): string {
  const offset = zoneOffset(at, SCHOOL_TIME_ZONE);
  const local = new Date(Math.floor(at.getTime() / 1000) * 1000 + offset).toISOString().slice(0, 19);
  const minutes = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
}
