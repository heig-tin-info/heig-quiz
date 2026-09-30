import { createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
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
import { DRILL_TARGET_RETENTION } from "./drillSession.js";

const DAY = 86_400_000;
const t0 = new Date("2026-10-01T08:00:00Z");
const after = (days: number) => new Date(t0.getTime() + days * DAY);

describe("the drill scheduler (FSRS-5)", () => {
  it("keeps the 21 weights, FSRS-5's 19 plus the two that neutralise FSRS-6", () => {
    expect(DRILL_FSRS_WEIGHTS).toHaveLength(21);
    expect(DRILL_FSRS_WEIGHTS.slice(19)).toEqual([0, 0.5]);
  });

  it("creates a new card due at once, with no retrievability", () => {
    const card = newDrillCard(t0);
    expect(card).toEqual({ stability: 0, difficulty: 0, dueAt: t0, lastReviewAt: null, reps: 0, lapses: 0 });
    expect(isNewDrillCard(card)).toBe(true);
    expect(drillRetrievability(card, after(3))).toBe(0);
  });

  it("round-trips: a card persisted as a DrillCard schedules the same next review as the library's own card", () => {
    const library = fsrs({
      w: [...DRILL_FSRS_WEIGHTS],
      request_retention: DRILL_TARGET_RETENTION,
      enable_fuzz: false,
      enable_short_term: false,
    });
    const persisted = (c: Card): DrillCard => ({
      stability: c.stability,
      difficulty: c.difficulty,
      dueAt: c.due,
      lastReviewAt: c.last_review!,
      reps: c.reps,
      lapses: c.lapses,
    });

    let theirs = createEmptyCard(t0);
    let ours = newDrillCard(t0);
    // A first review, a lapse, then reviews on time, early and late.
    const steps: [DrillRating, (due: Date) => Date][] = [
      [3, () => t0],
      [1, (due) => due],
      [2, (due) => due],
      [4, (due) => new Date(due.getTime() - DAY)],
      [3, (due) => new Date(due.getTime() + 5 * DAY)],
    ];
    for (const [rating, when] of steps) {
      const now = when(theirs.due);
      theirs = library.next(theirs, now, rating as Grade).card;
      // Our card went through the database's columns only.
      ours = reviewDrillCard(structuredClone(ours), rating, now);
      expect(ours).toEqual(persisted(theirs));
      expect(drillRetrievability(ours, after(40))).toBeCloseTo(library.get_retrievability(theirs, after(40), false), 12);
    }
  });

  it("is deterministic, and aims at the target retention when the card comes due", () => {
    const card = reviewDrillCard(reviewDrillCard(newDrillCard(t0), 3, t0), 3, after(3));
    expect(reviewDrillCard(card, 3, card.dueAt)).toEqual(reviewDrillCard(card, 3, card.dueAt));
    expect(drillRetrievability(card, card.dueAt)).toBeCloseTo(DRILL_TARGET_RETENTION, 1);
  });
});
