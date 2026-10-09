import { describe, expect, it } from "vitest";

import {
  calculatorOn,
  allowedFeedbackWhen,
  feedbackWhenFor,
  integrityJournalOn,
  isFeedbackAllowed,
  isInClass,
  isLiveState,
  logVisibilityDefault,
  modeChangeable,
  notepadOn,
  missingTimingFields,
  pastTiming,
  pausableMode,
  trustedClientsAllowedFor,
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

  it("asks a live exam without a limit for its safety deadline: an exam must announce its end (ADR-086 §2)", () => {
    expect(missingTimingFields({ ...base, timing: "manual" })).toEqual(["closesAt"]);
    expect(missingTimingFields({ ...base, timing: "manual", closesAt: new Date(0) })).toEqual([]);
    expect(missingTimingFields({ ...base, mode: "exercise", timing: "manual" })).toEqual([]);
  });
});

describe("pastTiming (#178)", () => {
  const now = new Date("2026-10-01T10:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  const deadline = { opensAt: at(-60_000), closesAt: now };

  it("refuses to schedule, open or start once the end is reached, the instant included", () => {
    for (const to of ["scheduled", "lobby", "running"] as const) {
      expect(pastTiming(deadline, "draft", to, now)).toBe("closes_at_past");
    }
    expect(pastTiming({ ...deadline, closesAt: at(1).toISOString() }, "lobby", "running", now)).toBeNull();
    // No end at all: nothing to pass.
    expect(pastTiming({ ...deadline, closesAt: null }, "lobby", "running", now)).toBeNull();
  });

  it("refuses a past opening only for a schedule", () => {
    const opening = { opensAt: now, closesAt: null };
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

describe("the rules an exam alone has", () => {
  it("pauses an exam only (docs/spec/01 §1)", () => {
    expect(pausableMode("exam")).toBe(true);
    expect(pausableMode("exercise")).toBe(false);
    expect(pausableMode("poll")).toBe(false);
  });

  it("offers the trusted clients to an exam only (ADR-051 §2)", () => {
    expect(trustedClientsAllowedFor("exam")).toBe(true);
    expect(trustedClientsAllowedFor("exercise")).toBe(false);
    expect(trustedClientsAllowedFor("poll")).toBe(false);
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

describe("notepadOn (ADR-090)", () => {
  it("is none when absent, and always none on a poll", () => {
    expect(notepadOn("exam", undefined)).toBe("none");
    expect(notepadOn("exercise", "provided")).toBe("provided");
    expect(notepadOn("exam", "provided_no_clipboard")).toBe("provided_no_clipboard");
    expect(notepadOn("poll", "provided")).toBe("none");
  });
});

describe("the integrity journal's switch (F-EVAL-13, ADR-088)", () => {
  it("defaults on for an exam only", () => {
    expect(logVisibilityDefault("exam")).toBe(true);
    expect(logVisibilityDefault("exercise")).toBe(false);
    expect(logVisibilityDefault("poll")).toBe(false);
  });

  it("follows the switch, and never journals a poll", () => {
    expect(integrityJournalOn("exam", true)).toBe(true);
    expect(integrityJournalOn("exercise", true)).toBe(true);
    expect(integrityJournalOn("exam", false)).toBe(false);
    expect(integrityJournalOn("poll", true)).toBe(false);
  });
});

describe("changing the mode (ADR-092)", () => {
  it("is open to a draft or scheduled evaluation nobody has attempted", () => {
    expect(modeChangeable("exam", "draft", 0)).toBe(true);
    expect(modeChangeable("exercise", "scheduled", 0)).toBe(true);
  });

  it("is closed from the lobby on, once an attempt exists, and on a poll", () => {
    for (const state of ["lobby", "running", "paused", "closed", "released"] as const) {
      expect(modeChangeable("exam", state, 0)).toBe(false);
    }
    expect(modeChangeable("exam", "draft", 1)).toBe(false);
    expect(modeChangeable("poll", "draft", 0)).toBe(false);
  });
});
