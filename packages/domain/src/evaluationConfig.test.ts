import { describe, expect, it } from "vitest";

import {
  calculatorOn,
  allowedFeedbackWhen,
  feedbackWhenFor,
  isFeedbackAllowed,
  isInClass,
  isLiveState,
  missingTimingFields,
  pastTiming,
  type TimingInput,
} from "./evaluationConfig.js";

describe("the feedback policies an evaluation may use (F-EVAL-11, #78)", () => {
  it("never offers `immediate` to an exam, whatever its waiting room", () => {
    for (const lobby of ["skip", "auto", "manual"] as const) {
      expect(allowedFeedbackWhen({ mode: "exam", lobby })).toEqual(["none", "on_release"]);
    }
  });

  it("offers all three to a take-home exercise, which has no waiting room", () => {
    expect(allowedFeedbackWhen({ mode: "exercise", lobby: "skip" })).toEqual([
      "none",
      "on_release",
      "immediate",
    ]);
    expect(isInClass({ mode: "exercise", lobby: "skip" })).toBe(false);
  });

  it("treats an exercise with a waiting room as sat in class", () => {
    for (const lobby of ["auto", "manual"] as const) {
      expect(isInClass({ mode: "exercise", lobby })).toBe(true);
      expect(isFeedbackAllowed({ mode: "exercise", lobby }, "immediate")).toBe(false);
      expect(isFeedbackAllowed({ mode: "exercise", lobby }, "on_release")).toBe(true);
    }
  });

  it("keeps `immediate` for a poll, whose feedback is the teacher's reveal (F-LIVE-13)", () => {
    expect(isFeedbackAllowed({ mode: "poll", lobby: "manual" }, "immediate")).toBe(true);
  });

  it("falls back to `on_release` only when the wanted policy is not allowed", () => {
    expect(feedbackWhenFor({ mode: "exam", lobby: "skip" }, "immediate")).toBe("on_release");
    expect(feedbackWhenFor({ mode: "exercise", lobby: "manual" }, "immediate")).toBe("on_release");
    expect(feedbackWhenFor({ mode: "exercise", lobby: "manual" }, "none")).toBe("none");
    expect(feedbackWhenFor({ mode: "exercise", lobby: "skip" }, "immediate")).toBe("immediate");
  });
});

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

describe("pastTiming (#178)", () => {
  const now = new Date("2026-10-01T10:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  const deadline = { timing: "deadline" as const, opensAt: at(-60_000), closesAt: now };

  it("refuses to schedule, open or start once the common end is reached, the instant included", () => {
    for (const to of ["scheduled", "lobby", "running"] as const) {
      expect(pastTiming(deadline, "draft", to, now)).toBe("closes_at_past");
    }
    expect(pastTiming({ ...deadline, closesAt: at(1).toISOString() }, "lobby", "running", now)).toBeNull();
    // A duration has no common end to pass.
    expect(pastTiming({ ...deadline, timing: "duration" }, "lobby", "running", now)).toBeNull();
  });

  it("refuses a past opening only for a schedule", () => {
    const opening = { timing: "duration" as const, opensAt: now, closesAt: null };
    expect(pastTiming(opening, "draft", "scheduled", now)).toBe("opens_at_past");
    expect(pastTiming(opening, "draft", "lobby", now)).toBeNull();
    expect(pastTiming({ ...opening, opensAt: at(1) }, "draft", "scheduled", now)).toBeNull();
  });

  it("never holds a resume, nor a move that starts nothing, to it", () => {
    expect(pastTiming(deadline, "paused", "running", now)).toBeNull();
    expect(pastTiming(deadline, "running", "closed", now)).toBeNull();
    expect(pastTiming(deadline, "scheduled", "draft", now)).toBeNull();
  });
});

describe("isLiveState", () => {
  it("holds while students sit the evaluation, and only then", () => {
    expect(["running", "paused"].every(isLiveState)).toBe(true);
    expect(["draft", "lobby", "closed", "grading", "released"].some(isLiveState)).toBe(false);
  });
});

describe("calculatorOn (ADR-069)", () => {
  it("is none when absent, and always none on a poll", () => {
    expect(calculatorOn("exam", undefined)).toBe("none");
    expect(calculatorOn("exercise", "scientific")).toBe("scientific");
    expect(calculatorOn("poll", "standard")).toBe("none");
  });
});
