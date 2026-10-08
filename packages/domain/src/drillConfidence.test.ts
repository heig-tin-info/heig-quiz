import { describe, expect, it } from "vitest";

import { DRILL_CONFIDENCE_LEVELS, drillConfidenceDue, drillConfidenceOutcome } from "./drillConfidence.js";

describe("drillConfidenceOutcome", () => {
  it("is unstated when the student skipped the question, whatever the answer", () => {
    for (const c of ["right", "partial", "wrong"] as const) expect(drillConfidenceOutcome(c, null)).toBe("unstated");
  });

  it("calls a wrong answer given sure or certain a confident error", () => {
    expect(drillConfidenceOutcome("wrong", 3)).toBe("confident_error");
    expect(drillConfidenceOutcome("wrong", 4)).toBe("confident_error");
  });

  it("does not call a wrong answer given fairly sure or less a confident error", () => {
    for (const c of [0, 1, 2] as const) expect(drillConfidenceOutcome("wrong", c)).toBe("calibrated");
  });

  it("counts a right answer with no idea as lucky, and only with no idea", () => {
    expect(drillConfidenceOutcome("right", 0)).toBe("lucky");
    for (const c of [1, 2, 3, 4] as const) expect(drillConfidenceOutcome("right", c)).toBe("calibrated");
  });

  it("never makes a partial answer a confident error nor lucky", () => {
    for (const c of DRILL_CONFIDENCE_LEVELS) expect(drillConfidenceOutcome("partial", c)).toBe("calibrated");
  });
});

describe("drillConfidenceDue", () => {
  // 10:00 in Zurich (CEST, UTC+2); the next local day starts at 22:00 UTC.
  const now = new Date("2026-10-05T08:00:00.000Z");
  const tomorrow = new Date("2026-10-05T22:00:00.000Z");
  const mature = new Date("2026-10-14T08:00:00.000Z");

  it("brings a confident error back at the start of the next local day", () => {
    expect(drillConfidenceDue("confident_error", mature, now)).toEqual(tomorrow);
  });

  it("keeps FSRS's due date when it is already earlier", () => {
    const sooner = new Date("2026-10-05T20:00:00.000Z");
    expect(drillConfidenceDue("confident_error", sooner, now)).toBe(sooner);
  });

  it("leaves every other outcome to FSRS", () => {
    for (const o of ["lucky", "calibrated", "unstated"] as const) expect(drillConfidenceDue(o, mature, now)).toBe(mature);
  });

  it("counts the day on the given clock, late in the evening included", () => {
    // 23:30 in Zurich is still the 5th: tomorrow starts 30 minutes later.
    expect(drillConfidenceDue("confident_error", mature, new Date("2026-10-05T21:30:00.000Z"))).toEqual(tomorrow);
    expect(drillConfidenceDue("confident_error", mature, now, "UTC")).toEqual(new Date("2026-10-06T00:00:00.000Z"));
  });

  it("follows the next day across a change of time", () => {
    // 25 October 2026, 02:30 CEST: summer time ends at 03:00, the day lasts
    // 25 hours and the 26th starts at 00:00 CET, 23:00 UTC.
    const later = new Date("2026-11-03T08:00:00.000Z");
    expect(drillConfidenceDue("confident_error", later, new Date("2026-10-25T00:30:00.000Z"))).toEqual(
      new Date("2026-10-25T23:00:00.000Z"),
    );
    // 29 March 2026, 01:30 CET: summer time starts at 02:00, the day lasts
    // 23 hours and the 30th starts at 00:00 CEST, 22:00 UTC.
    const spring = new Date("2026-04-07T08:00:00.000Z");
    expect(drillConfidenceDue("confident_error", spring, new Date("2026-03-29T00:30:00.000Z"))).toEqual(
      new Date("2026-03-29T22:00:00.000Z"),
    );
  });
});
