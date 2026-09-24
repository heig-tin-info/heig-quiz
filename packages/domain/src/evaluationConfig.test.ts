import { describe, expect, it } from "vitest";

import { missingTimingFields, type TimingInput } from "./evaluationConfig.js";

const base: TimingInput = {
  mode: "exam",
  timing: "duration",
  durationS: 2700,
  opensAt: null,
  closesAt: null,
};

describe("missingTimingFields (F-EVAL-04, decision D8)", () => {
  it("a duration needs a positive number of seconds, and nothing else", () => {
    expect(missingTimingFields(base)).toEqual([]);
    expect(missingTimingFields({ ...base, durationS: null })).toEqual(["durationS"]);
    expect(missingTimingFields({ ...base, durationS: 0 })).toEqual(["durationS"]);
  });

  it("a common end needs the opening time as well, since it is the base of the extra time", () => {
    const deadline = { ...base, timing: "deadline" as const, durationS: null };
    expect(missingTimingFields(deadline)).toEqual(["opensAt", "closesAt"]);
    expect(missingTimingFields({ ...deadline, closesAt: "2026-10-01T10:00:00.000Z" })).toEqual([
      "opensAt",
    ]);
    expect(missingTimingFields({ ...deadline, opensAt: new Date(0) })).toEqual(["closesAt"]);
    expect(
      missingTimingFields({ ...deadline, opensAt: new Date(0), closesAt: new Date(1) }),
    ).toEqual([]);
  });

  it("is the same rule for an exercise: the take-home preset is a common end too", () => {
    expect(
      missingTimingFields({
        mode: "exercise",
        timing: "deadline",
        durationS: null,
        opensAt: null,
        closesAt: "2026-10-01T10:00:00.000Z",
      }),
    ).toEqual(["opensAt"]);
  });

  it("refuses `I close it` for an exam only: an exam must announce its end", () => {
    expect(missingTimingFields({ ...base, timing: "manual" })).toEqual(["timing"]);
    expect(missingTimingFields({ ...base, mode: "exercise", timing: "manual" })).toEqual([]);
  });
});
