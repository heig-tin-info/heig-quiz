import { describe, expect, it } from "vitest";

import {
  answerExplained,
  CLIPPED_MARK,
  clipText,
  CONTESTATION_EXPORT_FIELD_CHARS,
  CONTESTATION_EXPORT_PAGE,
  CONTESTATION_EXPORT_PAGE_CHARS,
  contestationPage,
  proposalRefusal,
  proposalStale,
  type AnswerShape,
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

describe("an answer's shape (ADR-139 §14)", () => {
  const base: AnswerShape = { verdict: "accepted", reply: "", points: false, accepted: false };

  it("takes a bare acceptance, an acceptance with points and a reply, an accepted answer, a refusal with a reply", () => {
    expect(proposalRefusal(base)).toBeNull();
    expect(proposalRefusal({ ...base, points: true, reply: "Vous avez raison." })).toBeNull();
    expect(proposalRefusal({ ...base, accepted: true })).toBeNull();
    expect(proposalRefusal({ ...base, verdict: "refused", reply: "La clé est juste." })).toBeNull();
  });

  it("refuses, in order: a refusal with points or an accepted answer, both, and an unexplained one", () => {
    expect(proposalRefusal({ ...base, verdict: "refused", reply: "Non.", points: true })).toBe("refusal_with_points");
    expect(proposalRefusal({ ...base, verdict: "refused", reply: "Non.", accepted: true })).toBe("refusal_with_acceptance");
    expect(proposalRefusal({ ...base, reply: "Oui.", points: true, accepted: true })).toBe("points_and_acceptance");
    expect(proposalRefusal({ ...base, verdict: "refused" })).toBe("unexplained");
    expect(proposalRefusal({ ...base, points: true, reply: "  " })).toBe("unexplained");
  });

  it("is stale when the grading in force is not the one it recorded", () => {
    expect(proposalStale("g1", "g1")).toBe(false);
    expect(proposalStale(null, null)).toBe(false);
    expect(proposalStale("g1", "g2")).toBe(true);
    expect(proposalStale("g1", null)).toBe(true);
    expect(proposalStale(null, "g2")).toBe(true);
  });
});

describe("what an assistant reads, capped (ADR-139 §14)", () => {
  it("keeps a short text and cuts a long one with a visible mark, within the bound", () => {
    expect(clipText("court")).toBe("court");
    const cut = clipText("x".repeat(CONTESTATION_EXPORT_FIELD_CHARS + 50));
    expect(cut.length).toBeLessThanOrEqual(CONTESTATION_EXPORT_FIELD_CHARS);
    expect(cut.endsWith(CLIPPED_MARK)).toBe(true);
    expect(clipText("abcdefghij".repeat(10), 40)).toHaveLength(40);
  });

  it("takes at most a page within the characters, always one, and says where the next page starts", () => {
    expect(contestationPage([], 0, 0)).toEqual({ take: 0, next: null });
    expect(contestationPage(Array(30).fill(10), 0, 30)).toEqual({ take: CONTESTATION_EXPORT_PAGE, next: CONTESTATION_EXPORT_PAGE });
    const half = CONTESTATION_EXPORT_PAGE_CHARS / 2;
    expect(contestationPage([half, half, 1], 5, 8)).toEqual({ take: 2, next: 7 });
    expect(contestationPage([half, half + 1, 1], 0, 3)).toEqual({ take: 1, next: 1 });
    expect(contestationPage([CONTESTATION_EXPORT_PAGE_CHARS * 3, 1], 0, 2)).toEqual({ take: 1, next: 1 });
    expect(contestationPage([1, 1], 8, 10)).toEqual({ take: 2, next: null });
  });

  it("consumes a row it leaves out, so the next page never repeats one", () => {
    expect(contestationPage([null, 10, null], 0, 3)).toEqual({ take: 3, next: null });
    expect(contestationPage([null, CONTESTATION_EXPORT_PAGE_CHARS, null, 5], 0, 6)).toEqual({ take: 3, next: 3 });
  });
});
