import { describe, expect, it } from "vitest";

import {
  drillLocalDate,
  drillProgressRange,
  drillRecallCounts,
  drillRecallRate,
  drillRecallTrend,
  drillWeekOf,
  drillWeekStarts,
  DRILL_MAX_WEEKS,
  type DrillReviewFact,
} from "./drillProgress.js";

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 8));
const review = (cardId: string, day: number, rating: number): DrillReviewFact => ({
  cardId,
  reviewedAt: at(day),
  rating,
});

describe("drillRecallCounts", () => {
  it("leaves out the first review of each card, and counts the rest recalled unless Again", () => {
    const reviews = [
      review("a", 1, 1), // first of a: out, though it is an Again
      review("a", 3, 3),
      review("a", 8, 1),
      review("b", 2, 4), // first of b: out
      review("b", 6, 2),
      review("c", 5, 1), // only review of c: out
    ];
    expect(drillRecallCounts(reviews)).toEqual({ repeated: 3, recalled: 2 });
  });

  it("finds the first review by time, whatever the order of the rows", () => {
    expect(drillRecallCounts([review("a", 9, 1), review("a", 2, 1)])).toEqual({ repeated: 1, recalled: 0 });
  });

  it("decides the first review over the whole history, then counts the window only", () => {
    const reviews = [review("a", 1, 3), review("a", 10, 3), review("b", 10, 3)];
    // The window holds a's second review and b's first: only the former counts.
    const recent = drillRecallCounts(reviews, (r) => r.reviewedAt >= at(5));
    expect(recent).toEqual({ repeated: 1, recalled: 1 });
  });
});

describe("drillRecallRate and drillRecallTrend", () => {
  it("has no rate without a repeated review", () => {
    expect(drillRecallRate({ repeated: 0, recalled: 0 })).toBeNull();
    expect(drillRecallRate({ repeated: 4, recalled: 3 })).toBe(0.75);
  });

  it("draws a trend only over enough reviews, flat within five points", () => {
    expect(drillRecallTrend({ repeated: 10, recalled: 9 }, { repeated: 10, recalled: 7 })).toBe("up");
    expect(drillRecallTrend({ repeated: 10, recalled: 6 }, { repeated: 10, recalled: 8 })).toBe("down");
    expect(drillRecallTrend({ repeated: 20, recalled: 16 }, { repeated: 10, recalled: 8 })).toBe("flat");
    expect(drillRecallTrend({ repeated: 4, recalled: 4 }, { repeated: 10, recalled: 2 })).toBeNull();
    expect(drillRecallTrend({ repeated: 10, recalled: 10 }, { repeated: 0, recalled: 0 })).toBeNull();
  });
});

describe("the weeks", () => {
  it("counts a date on the Zurich clock", () => {
    // 23:30 UTC on 4 October is already the 5th in Zurich (UTC+2).
    expect(drillLocalDate(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-05");
    expect(drillLocalDate(new Date("2026-12-31T22:59:00Z"))).toBe("2026-12-31");
  });

  it("starts a week on Monday", () => {
    expect(drillWeekOf("2026-10-05")).toBe("2026-10-05"); // a Monday
    expect(drillWeekOf("2026-10-11")).toBe("2026-10-05"); // the Sunday after
    expect(drillWeekOf("2027-01-01")).toBe("2026-12-28"); // across the year
  });

  it("lists every week of a range, empty ones included, capped at the latest weeks", () => {
    expect(drillWeekStarts("2026-10-07", "2026-10-20")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(drillWeekStarts("2026-10-07", "2026-10-07")).toEqual(["2026-10-05"]);
    const long = drillWeekStarts("2020-01-01", "2026-10-07");
    expect(long).toHaveLength(DRILL_MAX_WEEKS);
    expect(long.at(-1)).toBe("2026-10-05");
  });

  it("spans the dated period, cut at today, or else the drill's own start", () => {
    const base = { enabledOn: "2026-09-20", firstReviewOn: null, today: "2026-11-10" };
    expect(drillProgressRange({ ...base, periodStart: "2026-09", periodEnd: "2027-01" })).toEqual({
      from: "2026-09-01",
      to: "2026-11-10",
    });
    expect(drillProgressRange({ ...base, today: "2027-03-01", periodStart: "2026-09", periodEnd: "2027-01" })).toEqual(
      { from: "2026-09-01", to: "2027-01-31" },
    );
    expect(drillProgressRange({ ...base, periodStart: "2027-02", periodEnd: "2027-06" })).toBeNull();
    expect(drillProgressRange({ ...base, periodStart: null, periodEnd: null })).toEqual({
      from: "2026-09-20",
      to: "2026-11-10",
    });
    expect(
      drillProgressRange({ ...base, firstReviewOn: "2026-09-01", periodStart: null, periodEnd: null })?.from,
    ).toBe("2026-09-01");
    expect(drillProgressRange({ ...base, enabledOn: null, periodStart: null, periodEnd: null })).toBeNull();
  });
});
