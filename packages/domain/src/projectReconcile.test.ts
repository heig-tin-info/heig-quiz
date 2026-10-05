import { describe, expect, it } from "vitest";

import { isQuiet, RECONCILE_AFTER_FREEZE_MS, RECONCILE_QUIET_MS, reconciles } from "./projectReconcile.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

describe("reconciles", () => {
  it("polls a repository not yet frozen", () => {
    expect(reconciles({ frozenAt: null, reviewGradeRunId: null }, false, NOW)).toBe(true);
    expect(reconciles({ frozenAt: null, reviewGradeRunId: "r1" }, true, NOW)).toBe(true);
  });

  it("polls a frozen repository for 24 hours after its freeze, then drops it", () => {
    expect(reconciles({ frozenAt: ago(HOUR), reviewGradeRunId: null }, false, NOW)).toBe(true);
    expect(reconciles({ frozenAt: ago(RECONCILE_AFTER_FREEZE_MS - 1), reviewGradeRunId: null }, false, NOW)).toBe(true);
    expect(reconciles({ frozenAt: ago(RECONCILE_AFTER_FREEZE_MS), reviewGradeRunId: null }, false, NOW)).toBe(false);
    expect(reconciles({ frozenAt: ago(30 * 24 * HOUR), reviewGradeRunId: null }, false, NOW)).toBe(false);
  });

  it("keeps polling past the day while a final review was asked and not answered", () => {
    const old = { frozenAt: ago(3 * 24 * HOUR) };
    expect(reconciles({ ...old, reviewGradeRunId: null }, true, NOW)).toBe(true);
    // Answered: the review slot filled, the day is the bound again.
    expect(reconciles({ ...old, reviewGradeRunId: "review-run" }, true, NOW)).toBe(false);
    // Never asked (graded `none`, archived as its lock): the day is the bound.
    expect(reconciles({ ...old, reviewGradeRunId: null }, false, NOW)).toBe(false);
  });
});

describe("isQuiet", () => {
  it("is quiet with no activity at all, or none for more than 30 minutes", () => {
    expect(isQuiet(null, NOW)).toBe(true);
    expect(isQuiet(ago(RECONCILE_QUIET_MS + 1), NOW)).toBe(true);
    expect(isQuiet(ago(2 * HOUR), NOW)).toBe(true);
  });

  it("is not quiet while something happened within 30 minutes", () => {
    expect(isQuiet(ago(RECONCILE_QUIET_MS), NOW)).toBe(false);
    expect(isQuiet(ago(60_000), NOW)).toBe(false);
    expect(isQuiet(NOW, NOW)).toBe(false);
  });
});
