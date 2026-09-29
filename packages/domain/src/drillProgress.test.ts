import { describe, expect, it } from "vitest";

import { drillProgress, type DrillReviewPoint } from "./drillProgress.js";
import type { DrillRating } from "./drillSchedule.js";

const WEEK = 7 * 86_400_000;
const from = new Date("2026-09-14T00:00:00Z");
const at = (week: number, minutes: number) => new Date(from.getTime() + week * WEEK + minutes * 60_000);
const review = (cardId: string, rating: DrillRating, reviewedAt: Date): DrillReviewPoint => ({ cardId, rating, reviewedAt });

describe("drillProgress", () => {
  it("returns empty windows for a student who never drilled", () => {
    const windows = drillProgress([], { from, windowMs: WEEK, count: 2 });
    expect(windows).toEqual([
      { start: from, end: at(1, 0), reviews: 0, cards: 0, sessions: 0, repeated: 0, recallRate: null },
      { start: at(1, 0), end: at(2, 0), reviews: 0, cards: 0, sessions: 0, repeated: 0, recallRate: null },
    ]);
    expect(drillProgress([], { from, windowMs: WEEK, count: 0 })).toEqual([]);
    expect(drillProgress([], { from, windowMs: WEEK, count: -1 })).toEqual([]);
  });

  it("counts reviews, distinct questions and sessions per window", () => {
    const reviews = [
      review("a", 3, at(0, 0)),
      review("b", 1, at(0, 5)),
      review("a", 3, at(0, 10)), // same session, same question
      review("c", 3, at(0, 100)), // a second session: more than 30 min later
      review("d", 3, at(1, 0)),
    ];
    const [w0, w1] = drillProgress(reviews, { from, windowMs: WEEK, count: 2 });
    expect(w0).toMatchObject({ reviews: 4, cards: 3, sessions: 2 });
    expect(w1).toMatchObject({ reviews: 1, cards: 1, sessions: 1 });
  });

  it("rates recall on repeated questions only, and shows its rise over the windows", () => {
    const reviews = [
      // week 0: first meetings (not counted), then two repeats, one forgotten
      review("a", 1, at(0, 0)),
      review("b", 3, at(0, 1)),
      review("a", 1, at(0, 2000)),
      review("b", 3, at(0, 2001)),
      // week 1: both remembered
      review("a", 3, at(1, 0)),
      review("b", 4, at(1, 1)),
    ];
    const windows = drillProgress([...reviews].reverse(), { from, windowMs: WEEK, count: 2 });
    expect(windows.map((w) => [w.repeated, w.recallRate])).toEqual([
      [2, 0.5],
      [2, 1],
    ]);
  });

  it("uses history before the first window for repeats and sessions, and ignores reviews outside every window", () => {
    const reviews = [
      review("a", 3, at(0, -10)), // before `from`: not counted, but `a` is now known
      review("a", 1, at(0, 5)), // same session as the one before: no new session
      review("b", 3, at(3, 0)), // after the last window
    ];
    const [w0] = drillProgress(reviews, { from, windowMs: WEEK, count: 1 });
    expect(w0).toMatchObject({ reviews: 1, cards: 1, sessions: 0, repeated: 1, recallRate: 0 });
  });
});
