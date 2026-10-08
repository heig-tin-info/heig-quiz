import { describe, expect, it } from "vitest";

import { DRILL_CONFIDENCE_LEVELS, drillConfidenceOutcome } from "./drillConfidence.js";

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
