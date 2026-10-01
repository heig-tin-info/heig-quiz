/*
 * The pure half of the Activities section (#190): which bucket a state falls
 * in, the moment that places a row in time, the default order, and the
 * weeks of the schedule. No React, so every rule is unit-tested on its own.
 *
 * "Live" is not decided here: it is `isLiveNow` of `@quiz/domain`, the deploy
 * guard's definition, so the section and the guard can never disagree.
 */
import type { EvaluationActivitySummary, EvaluationMode, EvaluationState } from "@quiz/contracts";

/** The three ages of an activity, as the state filter offers them. */
export type Bucket = "upcoming" | "open" | "ended";
export const BUCKETS: readonly Bucket[] = ["upcoming", "open", "ended"];
export const MODES: readonly EvaluationMode[] = ["exam", "exercise", "poll"];

const BUCKET_OF: Record<EvaluationState, Bucket> = {
  draft: "upcoming",
  scheduled: "upcoming",
  lobby: "open",
  running: "open",
  paused: "open",
  closed: "ended",
  grading: "ended",
  released: "ended",
};

export function bucketOf(state: EvaluationState): Bucket {
  return BUCKET_OF[state];
}

/**
 * The moment that places a row in time: when it opens, or when it actually
 * started, or when it closes. Null for a draft nobody dated yet — the
 * schedule files it under "Not scheduled".
 */
export function anchorOf(a: EvaluationActivitySummary): string | null {
  return a.opensAt ?? a.startedAt ?? a.closesAt;
}

const time = (iso: string | null) => (iso === null ? null : new Date(iso).getTime());

/**
 * The order nobody clicked for: what is open first, then what comes next
 * (the soonest first, the undated drafts last), then what is over (the most
 * recent first). It answers "what needs me" before "what happened".
 */
export function activityOrder(rows: readonly EvaluationActivitySummary[]): EvaluationActivitySummary[] {
  const rank: Record<Bucket, number> = { open: 0, upcoming: 1, ended: 2 };
  return [...rows].sort((a, b) => {
    const byBucket = rank[bucketOf(a.state)] - rank[bucketOf(b.state)];
    if (byBucket !== 0) return byBucket;
    const [ta, tb] = [time(anchorOf(a)), time(anchorOf(b))];
    if (ta === tb) return a.title.localeCompare(b.title);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return bucketOf(a.state) === "ended" ? tb - ta : ta - tb;
  });
}

export interface Filters {
  modes: ReadonlySet<EvaluationMode>;
  buckets: ReadonlySet<Bucket>;
}

/** An empty set filters nothing: no chip pressed is "everything". */
export function matches(a: EvaluationActivitySummary, f: Filters): boolean {
  return (
    (f.modes.size === 0 || f.modes.has(a.mode)) &&
    (f.buckets.size === 0 || f.buckets.has(bucketOf(a.state)))
  );
}

// --- The schedule ------------------------------------------------------------

const DAY = 86_400_000;

/** Local midnight of the Monday of `t`'s week. */
export function mondayOf(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** ISO 8601 week number (weeks start on Monday, week 1 holds the first Thursday). */
export function isoWeek(t: number): number {
  const monday = mondayOf(t);
  // The Thursday of the week decides its year; week 1 holds 4 January.
  const year = new Date(monday + 3 * DAY).getFullYear();
  const first = mondayOf(new Date(year, 0, 4).getTime());
  // Rounded: a daylight-saving change makes one week an hour short or long.
  return 1 + Math.round((monday - first) / (7 * DAY));
}

export interface Week {
  /** Local midnight of its Monday; null for the undated rows. */
  start: number | null;
  rows: EvaluationActivitySummary[];
}

/**
 * Where the schedule files a row: an OPEN one is filed under now — it is
 * this week's business, whenever it opened (a two-week series opened last
 * Monday, an exam in its lobby with no date at all) — anything else under
 * {@link anchorOf}.
 */
export function scheduleAnchorOf(a: EvaluationActivitySummary, now: number): number | null {
  return bucketOf(a.state) === "open" ? now : time(anchorOf(a));
}

const shownTime = (a: EvaluationActivitySummary, now: number): number =>
  time(anchorOf(a)) ?? scheduleAnchorOf(a, now)!;

/**
 * The rows by the week of their schedule anchor, oldest week first, each
 * week in time order; the undated drafts last, in a week of their own.
 */
export function weeksOf(rows: readonly EvaluationActivitySummary[], now: number): Week[] {
  const byWeek = new Map<number, EvaluationActivitySummary[]>();
  const undated: EvaluationActivitySummary[] = [];
  for (const row of rows) {
    const anchor = scheduleAnchorOf(row, now);
    if (anchor === null) {
      undated.push(row);
      continue;
    }
    const start = mondayOf(anchor);
    byWeek.set(start, [...(byWeek.get(start) ?? []), row]);
  }
  const weeks: Week[] = [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, list]) => ({
      start,
      // Inside a week, by the time the row shows (an open series opened
      // last Monday leads this week); an undated lobby by now.
      rows: list.sort((a, b) => shownTime(a, now) - shownTime(b, now) || a.title.localeCompare(b.title)),
    }));
  if (undated.length > 0) {
    weeks.push({ start: null, rows: undated.sort((a, b) => a.title.localeCompare(b.title)) });
  }
  return weeks;
}

/**
 * A week the schedule may fold away: before this one, and holding nothing
 * but ended rows. A week with something open or still to come never folds —
 * it is exactly what the teacher must not lose behind a button.
 */
export function foldable(week: Week, now: number): boolean {
  return (
    week.start !== null &&
    week.start < mondayOf(now) &&
    week.rows.every((row) => bucketOf(row.state) === "ended")
  );
}
