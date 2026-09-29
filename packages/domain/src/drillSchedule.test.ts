import { describe, expect, it } from "vitest";

import {
  DRILL_FSRS_WEIGHTS,
  drillRetrievability,
  isNewDrillCard,
  newDrillCard,
  reviewDrillCard,
  type DrillCard,
  type DrillRating,
} from "./drillSchedule.js";

const DAY = 86_400_000;
const t0 = new Date("2026-10-01T08:00:00Z");
const after = (days: number) => new Date(t0.getTime() + days * DAY);
const intervalDays = (card: DrillCard) => (card.dueAt.getTime() - card.lastReviewAt!.getTime()) / DAY;

describe("the drill scheduler (FSRS-5)", () => {
  it("keeps the 21 weights, FSRS-5's 19 plus the two that neutralise FSRS-6", () => {
    expect(DRILL_FSRS_WEIGHTS).toHaveLength(21);
    expect(DRILL_FSRS_WEIGHTS.slice(19)).toEqual([0, 0.5]);
  });

  it("creates a new card due at once, with no retrievability to lose", () => {
    const card = newDrillCard(t0);
    expect(card).toEqual({ stability: 0, difficulty: 0, dueAt: t0, lastReviewAt: null, reps: 0, lapses: 0 });
    expect(isNewDrillCard(card)).toBe(true);
    expect(drillRetrievability(card, after(3))).toBe(0);
  });

  it("gives a first review FSRS-5's initial stability for its rating, and a day-scale interval", () => {
    const ratings: DrillRating[] = [1, 2, 3, 4];
    const cards = ratings.map((r) => reviewDrillCard(newDrillCard(t0), r, t0));
    expect(cards.map((c) => c.stability)).toEqual(DRILL_FSRS_WEIGHTS.slice(0, 4));
    for (const card of cards) {
      expect(card.lastReviewAt).toEqual(t0);
      expect(card.reps).toBe(1);
      expect(card.lapses).toBe(0);
      expect(Number.isInteger(intervalDays(card))).toBe(true);
      expect(intervalDays(card)).toBeGreaterThanOrEqual(1);
    }
    // Easier ratings push the card further away.
    const intervals = cards.map(intervalDays);
    expect([...intervals].sort((a, b) => a - b)).toEqual(intervals);
    expect(intervals[3]).toBeGreaterThan(intervals[0]!);
  });

  it("is deterministic: the same review yields the same card", () => {
    expect(reviewDrillCard(newDrillCard(t0), 3, t0)).toEqual(reviewDrillCard(newDrillCard(t0), 3, t0));
  });

  it("stretches the interval on a Good review of a due card, and shortens it on a lapse", () => {
    const first = reviewDrillCard(newDrillCard(t0), 3, t0);
    const good = reviewDrillCard(first, 3, first.dueAt);
    expect(good.stability).toBeGreaterThan(first.stability);
    expect(intervalDays(good)).toBeGreaterThan(intervalDays(first));
    expect(good.reps).toBe(2);

    const again = reviewDrillCard(good, 1, good.dueAt);
    expect(again.lapses).toBe(1);
    expect(again.stability).toBeLessThan(good.stability);
    expect(intervalDays(again)).toBeLessThan(intervalDays(good));
  });

  it("lets retrievability decay, to about the target retention when the card comes due", () => {
    const card = reviewDrillCard(reviewDrillCard(newDrillCard(t0), 3, t0), 3, after(3));
    expect(drillRetrievability(card, card.lastReviewAt!)).toBeCloseTo(1, 5);
    const atDue = drillRetrievability(card, card.dueAt);
    expect(atDue).toBeGreaterThan(0.88);
    expect(atDue).toBeLessThan(0.92);
    expect(drillRetrievability(card, after(400))).toBeLessThan(atDue);
  });
});
