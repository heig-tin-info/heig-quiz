/**
 * A student's drill activity and progression over time, for the teacher's
 * view (F-DRILL-04 as amended by ADR-041 §7): whether they practise —
 * reviews, distinct questions, sessions — and whether they remember more,
 * measured by the RECALL RATE: among the reviews of a question the student
 * had already drilled before, the share not rated Again.
 *
 * The first drill review of a question is left out of the rate: it
 * measures what the evaluation left, not what practice kept. The rate is
 * FSRS's own "true retention", so a student whose schedule works sits near
 * `DRILL_TARGET_RETENTION`; its rise across windows is the progression.
 */
import type { DrillRating } from "./drillSchedule.js";

/** A pause longer than this between two reviews starts a new session. */
export const DRILL_SESSION_GAP_MS = 1_800_000;

export interface DrillReviewPoint {
  cardId: string;
  rating: DrillRating;
  reviewedAt: Date;
}

export interface DrillWindow {
  start: Date;
  /** Exclusive. */
  end: Date;
  reviews: number;
  /** Distinct questions reviewed. */
  cards: number;
  /** Sessions STARTED in the window. */
  sessions: number;
  /** Reviews counted in the rate: those of a question already drilled before. */
  repeated: number;
  /** Share of `repeated` not rated Again; null when `repeated` is 0. */
  recallRate: number | null;
}

export interface DrillProgressOptions {
  /** Start of the first window. */
  from: Date;
  windowMs: number;
  count: number;
}

/**
 * `count` consecutive windows of `windowMs` from `from`. `reviews` is the
 * student's WHOLE history, in any order: a review before `from` is not
 * counted but still makes the next review of its question a repeat, and
 * still joins the session it belongs to.
 */
export function drillProgress(reviews: readonly DrillReviewPoint[], options: DrillProgressOptions): DrillWindow[] {
  const { from, windowMs, count } = options;
  const windows = Array.from({ length: Math.max(0, count) }, (_, i) => ({
    start: new Date(from.getTime() + i * windowMs),
    end: new Date(from.getTime() + (i + 1) * windowMs),
    reviews: 0,
    cards: new Set<string>(),
    sessions: 0,
    repeated: 0,
    recalled: 0,
  }));
  const at = (t: number) => {
    const i = Math.floor((t - from.getTime()) / windowMs);
    return i >= 0 && i < windows.length ? windows[i] : undefined;
  };

  const seen = new Set<string>();
  let last = -Infinity;
  for (const review of [...reviews].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime())) {
    const t = review.reviewedAt.getTime();
    const window = at(t);
    if (window) {
      window.reviews += 1;
      window.cards.add(review.cardId);
      if (t - last > DRILL_SESSION_GAP_MS) window.sessions += 1;
      if (seen.has(review.cardId)) {
        window.repeated += 1;
        if (review.rating > 1) window.recalled += 1;
      }
    }
    seen.add(review.cardId);
    last = t;
  }

  return windows.map(({ start, end, reviews: n, cards, sessions, repeated, recalled }) => ({
    start,
    end,
    reviews: n,
    cards: cards.size,
    sessions,
    repeated,
    recallRate: repeated === 0 ? null : recalled / repeated,
  }));
}
