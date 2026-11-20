import { describe, expect, it } from "vitest";

import {
  answerExplained,
  CONTESTATION_DAYS_DEFAULT,
  contestationClosesAt,
  contestationDaysOf,
  contestationWindowApplies,
  contestationWindowOpen,
  contestedUnit,
  unitRefusal,
  windowExtendRefusal,
  type ContestedUnit,
} from "./contestation.js";

const RELEASE = new Date("2026-11-20T10:00:00.000Z");
const at = (iso: string) => new Date(iso);
const UNIT: ContestedUnit = { shown: true, counted: true, counting: true, graded: true, full: false };

describe("the window (ADR-139)", () => {
  it("closes whole days after the release, none at 0", () => {
    expect(contestationClosesAt(RELEASE, 7)).toEqual(at("2026-11-27T10:00:00.000Z"));
    expect(contestationClosesAt(RELEASE, 1)).toEqual(at("2026-11-21T10:00:00.000Z"));
    expect(contestationClosesAt(RELEASE, 0)).toBeNull();
  });

  it("reads a policy's days, seven when it chose none", () => {
    expect(contestationDaysOf({})).toBe(CONTESTATION_DAYS_DEFAULT);
    expect(contestationDaysOf({ contestationDays: 0 })).toBe(0);
    expect(contestationDaysOf({ contestationDays: 12 })).toBe(12);
  });

  it("applies to a released exam whose policy shows results, and nothing else", () => {
    expect(contestationWindowApplies({ exam: true, released: true, when: "on_release" })).toBe(true);
    expect(contestationWindowApplies({ exam: true, released: true, when: "none" })).toBe(false);
    expect(contestationWindowApplies({ exam: true, released: false, when: "on_release" })).toBe(false);
    expect(contestationWindowApplies({ exam: false, released: true, when: "on_release" })).toBe(false);
  });

  it("holds while released and before its instant, the instant itself excluded", () => {
    const closesAt = at("2026-11-27T10:00:00.000Z");
    expect(contestationWindowOpen({ released: true, closesAt }, at("2026-11-27T09:59:59.999Z"))).toBe(true);
    expect(contestationWindowOpen({ released: true, closesAt }, closesAt)).toBe(false);
    expect(contestationWindowOpen({ released: false, closesAt }, RELEASE)).toBe(false);
    expect(contestationWindowOpen({ released: true, closesAt: null }, RELEASE)).toBe(false);
  });
});

describe("what may be contested", () => {
  it("builds the facts from the validated grading in force", () => {
    const base = { shown: true, counted: true, counting: true };
    expect(contestedUnit({ ...base, grading: { points: 0.5, maxPoints: 1 } })).toEqual(UNIT);
    expect(contestedUnit({ ...base, grading: { points: 1, maxPoints: 1 } })).toMatchObject({ graded: true, full: true });
    expect(contestedUnit({ ...base, grading: null })).toMatchObject({ graded: false, full: false });
  });

  it("lets a graded, counted, shown unit below full points be contested", () => {
    expect(unitRefusal(UNIT)).toBeNull();
  });

  it("refuses in order: shown, counted, counting, pending, full", () => {
    expect(unitRefusal({ ...UNIT, shown: false, counted: false })).toBe("not_shown");
    expect(unitRefusal({ ...UNIT, counted: false, counting: false })).toBe("not_counted");
    expect(unitRefusal({ ...UNIT, counting: false, graded: false })).toBe("not_counting");
    expect(unitRefusal({ ...UNIT, graded: false, full: true })).toBe("pending");
    expect(unitRefusal({ ...UNIT, full: true })).toBe("full_points");
  });
});

describe("answerExplained", () => {
  it("asks a reply of a refusal and of new points, not of a bare acceptance", () => {
    expect(answerExplained({ verdict: "refused", reply: " ", points: false })).toBe(false);
    expect(answerExplained({ verdict: "accepted", reply: "", points: true })).toBe(false);
    expect(answerExplained({ verdict: "accepted", reply: "", points: false })).toBe(true);
    expect(answerExplained({ verdict: "refused", reply: "The key holds.", points: false })).toBe(true);
    expect(answerExplained({ verdict: "accepted", reply: "Right.", points: true })).toBe(true);
  });
});

describe("windowExtendRefusal", () => {
  it("takes a future instant within 90 days", () => {
    expect(windowExtendRefusal(at("2026-11-21T10:00:00.000Z"), RELEASE)).toBeNull();
    expect(windowExtendRefusal(RELEASE, RELEASE)).toBe("not_future");
    expect(windowExtendRefusal(at("2026-11-19T10:00:00.000Z"), RELEASE)).toBe("not_future");
    expect(windowExtendRefusal(at("2027-02-18T10:00:00.000Z"), RELEASE)).toBeNull();
    expect(windowExtendRefusal(at("2027-02-18T10:00:00.001Z"), RELEASE)).toBe("too_far");
  });
});
