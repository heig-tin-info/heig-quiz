import { describe, expect, it } from "vitest";

import { RECONCILE_AFTER_FREEZE_MS, RECONCILE_REVIEW_WAIT_MS, reconciles } from "./projectReconcile.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOTHING = { finalReview: false, ciPass: false };
const REVIEW = { finalReview: true, ciPass: false };
const CI_PASS = { finalReview: false, ciPass: true };

describe("reconciles", () => {
  it("polls a repository not yet frozen", () => {
    expect(reconciles({ frozenAt: null, reviewGradeRunId: null }, NOTHING, NOW)).toBe(true);
    expect(reconciles({ frozenAt: null, reviewGradeRunId: "r1" }, REVIEW, NOW)).toBe(true);
  });

  it("polls a frozen repository for 24 hours after its freeze, then drops it", () => {
    expect(reconciles({ frozenAt: ago(HOUR), reviewGradeRunId: null }, NOTHING, NOW)).toBe(true);
    expect(reconciles({ frozenAt: ago(RECONCILE_AFTER_FREEZE_MS - 1), reviewGradeRunId: null }, NOTHING, NOW)).toBe(true);
    expect(reconciles({ frozenAt: ago(RECONCILE_AFTER_FREEZE_MS), reviewGradeRunId: null }, NOTHING, NOW)).toBe(false);
    expect(reconciles({ frozenAt: ago(30 * DAY), reviewGradeRunId: null }, NOTHING, NOW)).toBe(false);
  });

  it("keeps polling past the day while a final review was asked and not answered", () => {
    const old = { frozenAt: ago(3 * DAY) };
    expect(reconciles({ ...old, reviewGradeRunId: null }, REVIEW, NOW)).toBe(true);
    // Answered: the review slot filled, the day is the bound again.
    expect(reconciles({ ...old, reviewGradeRunId: "review-run" }, REVIEW, NOW)).toBe(false);
    // Never asked (graded `none`, archived as its lock): the day is the bound.
    expect(reconciles({ ...old, reviewGradeRunId: null }, NOTHING, NOW)).toBe(false);
  });

  it("gives up an unanswered final review 7 days after the freeze", () => {
    const unanswered = (frozenFor: number) => reconciles({ frozenAt: ago(frozenFor), reviewGradeRunId: null }, REVIEW, NOW);
    expect(RECONCILE_REVIEW_WAIT_MS).toBe(7 * DAY);
    expect(unanswered(6 * DAY)).toBe(true);
    expect(unanswered(RECONCILE_REVIEW_WAIT_MS - 1)).toBe(true);
    expect(unanswered(RECONCILE_REVIEW_WAIT_MS)).toBe(false);
    expect(unanswered(8 * DAY)).toBe(false);
    // Frozen in September, polled forever until now: no longer.
    expect(unanswered(60 * DAY)).toBe(false);
  });

  it("polls a repository with a CI pass open whatever the freeze's age: a Regrade weeks later (ADR-132)", () => {
    expect(reconciles({ frozenAt: ago(8 * DAY), reviewGradeRunId: null }, CI_PASS, NOW)).toBe(true);
    expect(reconciles({ frozenAt: ago(60 * DAY), reviewGradeRunId: "r1" }, { finalReview: true, ciPass: true }, NOW)).toBe(true);
  });
});
