/**
 * What the teacher reads of a student's drill (ADR-041 §8, §10 item 8,
 * #317 slice 4): the recall rate on repeated reviews, its trend, and the
 * weeks the progression is drawn over.
 *
 * The recall rate is FSRS's "true retention": among the reviews of a card
 * the student had ALREADY drilled, the share not rated Again. A card's first
 * drill review is left out, since it measures the evaluation, not the
 * practice. The API aggregates it in SQL over a classroom's reviews; the
 * reference definition is {@link drillRecallCounts}, and the database test
 * holds the two to the same numbers.
 */
import { DRILL_TIME_ZONE } from "./drillSession.js";

/**
 * The share of cards the scheduler aims to have remembered when they come
 * due (ADR-041 §5): what a recall rate near target means the schedule works.
 */
export const DRILL_TARGET_RETENTION = 0.9;

/** A review counts as recalled from this rating on: anything but 1 Again. */
export const DRILL_RECALLED_MIN_RATING = 2;

/**
 * Below this many repeated reviews in either window, a trend is noise and
 * none is drawn.
 */
export const DRILL_TREND_MIN_REVIEWS = 5;

/** A change of the recall rate smaller than this (5 points) reads as flat. */
export const DRILL_TREND_THRESHOLD = 0.05;

/** The repeated reviews of a window, and those of them recalled. */
export interface DrillRecall {
  repeated: number;
  recalled: number;
}

export interface DrillReviewFact {
  cardId: string;
  reviewedAt: Date;
  rating: number;
}

/**
 * The reference definition: the first review of each card (by time) is
 * left out, every later one counts as repeated, and recalled when not
 * Again. `inWindow` picks the reviews that count once the first ones are
 * known — the first review is decided over the whole history, not the
 * window.
 */
export function drillRecallCounts(
  reviews: readonly DrillReviewFact[],
  inWindow: (review: DrillReviewFact) => boolean = () => true,
): DrillRecall {
  const first = new Map<string, DrillReviewFact>();
  for (const r of reviews) {
    const known = first.get(r.cardId);
    if (!known || r.reviewedAt < known.reviewedAt) first.set(r.cardId, r);
  }
  let repeated = 0;
  let recalled = 0;
  for (const r of reviews) {
    if (first.get(r.cardId) === r || !inWindow(r)) continue;
    repeated += 1;
    if (r.rating >= DRILL_RECALLED_MIN_RATING) recalled += 1;
  }
  return { repeated, recalled };
}

/** The recall rate, 0 to 1; null when nothing was repeated (no rate, not a zero). */
export function drillRecallRate(recall: DrillRecall): number | null {
  return recall.repeated === 0 ? null : recall.recalled / recall.repeated;
}

export type DrillTrend = "up" | "down" | "flat";

/**
 * The recall rate of a recent window against the one before it; null when
 * either holds fewer than {@link DRILL_TREND_MIN_REVIEWS} repeated reviews.
 */
export function drillRecallTrend(current: DrillRecall, previous: DrillRecall): DrillTrend | null {
  if (current.repeated < DRILL_TREND_MIN_REVIEWS || previous.repeated < DRILL_TREND_MIN_REVIEWS) return null;
  const delta = drillRecallRate(current)! - drillRecallRate(previous)!;
  if (delta >= DRILL_TREND_THRESHOLD) return "up";
  if (delta <= -DRILL_TREND_THRESHOLD) return "down";
  return "flat";
}

// --- Weeks -------------------------------------------------------------------

/** An ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

const DAY_MS = 86_400_000;
const toDate = (d: IsoDate) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/** The calendar date of an instant on the drill's clock (Europe/Zurich), where its days are counted. */
export function drillLocalDate(at: Date, timeZone: string = DRILL_TIME_ZONE): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The Monday of the week holding `date`: a week runs Monday to Sunday, as PostgreSQL's `date_trunc('week')`. */
export function drillWeekOf(date: IsoDate): IsoDate {
  const ms = toDate(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return fromDate(ms - weekday * DAY_MS);
}

/** At most this many weeks are drawn: two years. A longer range keeps its latest weeks. */
export const DRILL_MAX_WEEKS = 104;

/** The Mondays of every week from the one holding `from` to the one holding `to`, both included. */
export function drillWeekStarts(from: IsoDate, to: IsoDate): IsoDate[] {
  const first = toDate(drillWeekOf(from));
  const last = toDate(drillWeekOf(to));
  const weeks: IsoDate[] = [];
  for (let ms = last; ms >= first && weeks.length < DRILL_MAX_WEEKS; ms -= 7 * DAY_MS) weeks.push(fromDate(ms));
  return weeks.reverse();
}

/**
 * The dates the weekly progression spans: the classroom's dated period
 * (`YYYY-MM` months, both included) when it has one, cut at today; else
 * from when the drill was enabled — or the first review, if earlier — to
 * today. Null when there is nothing to draw from.
 */
export function drillProgressRange(input: {
  periodStart: string | null;
  periodEnd: string | null;
  /** Local dates (`drillLocalDate`). */
  enabledOn: IsoDate | null;
  firstReviewOn: IsoDate | null;
  today: IsoDate;
}): { from: IsoDate; to: IsoDate } | null {
  const { periodStart, periodEnd, enabledOn, firstReviewOn, today } = input;
  if (periodStart && periodEnd) {
    const from = `${periodStart}-01`;
    const [y, m] = periodEnd.split("-").map(Number) as [number, number];
    const end = fromDate(Date.UTC(y, m, 0));
    const to = end < today ? end : today;
    return from <= to ? { from, to } : null;
  }
  const starts = [enabledOn, firstReviewOn].filter((d): d is IsoDate => d !== null).sort();
  const from = starts[0];
  if (from === undefined) return null;
  return { from, to: today };
}
