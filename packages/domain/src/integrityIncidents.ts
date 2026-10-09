/**
 * The integrity journal as a teacher reads it (ADR-088 §5, §7): the raw
 * `visibility`, `focus` and `paste` rows of one attempt turned into
 * "incidents" — an absence from the page, or a paste from outside it.
 *
 * Every time is the server's (the rows are stamped on receipt, invariant 5),
 * so the one-second rule is applied here, on the read, and never trusted to
 * the client. A duration is indicative, and capped at the attempt's end.
 */

/** One journal row, as stored: `at` is the server's receipt time. */
export interface JournalRow {
  kind: string;
  at: Date;
  details: unknown;
}

export type Incident =
  | {
      kind: "left";
      at: Date;
      /** `null` while the absence is still going on (no return, the attempt still open). */
      durationMs: number | null;
    }
  | {
      kind: "paste";
      at: Date;
      /** Characters pasted; `null` when the row does not say. */
      length: number | null;
      afterFocusLoss: boolean;
    };

/**
 * An absence shorter than this is a slip (a notification, a mis-click), not
 * an incident — and not worth the student's toast either: the player
 * (`apps/web/src/attempt/integrity.ts`) reads the same constant.
 */
export const MIN_ABSENCE_MS = 1_000;

/**
 * The incidents of one attempt, in time order. `rows` are its journal rows in
 * time order (any kind: the others are ignored). `endAt` is when the attempt
 * ended — closed, or its deadline passed — or `null` while it runs; `now` is
 * the server's instant.
 *
 * A focus loss and a hidden tab that overlap are ONE absence: it starts at the
 * first loss and ends at the first return, exactly as the player counts it
 * for its toast (`useIntegrityJournal`, `apps/web/src/attempt/integrity.ts`).
 * An absence still open when the attempt ended is closed at the end, and rows
 * after the end are ignored; one still open while the attempt runs has no
 * duration yet. An absence shorter than {@link MIN_ABSENCE_MS} — or open for
 * less than that — is dropped.
 */
export function integrityIncidents(
  rows: readonly JournalRow[],
  endAt: Date | null,
  now: Date,
): Incident[] {
  const end = endAt !== null && endAt.getTime() <= now.getTime() ? endAt.getTime() : null;
  const incidents: Incident[] = [];
  let awaySince: Date | null = null;

  const close = (from: Date, until: number) => {
    const durationMs = until - from.getTime();
    if (durationMs >= MIN_ABSENCE_MS) incidents.push({ kind: "left", at: from, durationMs });
  };

  for (const row of rows) {
    if (end !== null && row.at.getTime() >= end) break;
    const details = (row.details ?? {}) as Record<string, unknown>;
    // Whether the row says the page was left (true), came back (false), or neither.
    let leaving: boolean | null = null;
    if (row.kind === "paste") {
      incidents.push({
        kind: "paste",
        at: row.at,
        length: typeof details.length === "number" ? details.length : null,
        afterFocusLoss: details.afterFocusLoss === true,
      });
    } else if (row.kind === "focus" && typeof details.focused === "boolean") {
      leaving = !details.focused;
    } else if (row.kind === "visibility" && (details.state === "hidden" || details.state === "visible")) {
      leaving = details.state === "hidden";
    }
    if (leaving === true) {
      awaySince ??= row.at;
    } else if (leaving === false && awaySince !== null) {
      close(awaySince, row.at.getTime());
      awaySince = null;
    }
  }

  if (awaySince !== null) {
    if (end !== null) close(awaySince, end);
    else if (now.getTime() - awaySince.getTime() >= MIN_ABSENCE_MS) {
      incidents.push({ kind: "left", at: awaySince, durationMs: null });
    }
  }
  // An absence is pushed at its return: a paste during it was pushed first.
  return incidents.sort((a, b) => a.at.getTime() - b.at.getTime());
}
