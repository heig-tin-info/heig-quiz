import { describe, expect, it } from "vitest";

import {
  afterDueOpen,
  PRACTICE_DEFAULT_S,
  practiceCooldownS,
  practiceDeadline,
  practiceDurationS,
  practiceOwnLimit,
  practiceRefusal,
} from "./afterDue.js";
import { gradableNow } from "./retake.js";

const exercise = { mode: "exercise" as const, afterDue: undefined, feedbackWhen: "on_release" as const, showKey: true };

describe("afterDueOpen (ADR-122 §1)", () => {
  it("is open by default on an exercise", () => {
    expect(afterDueOpen(exercise)).toBe(true);
    expect(afterDueOpen({ ...exercise, feedbackWhen: "immediate" })).toBe(true);
  });

  it("is hidden by default where the key stays hidden: the policy none, or no key shown", () => {
    expect(afterDueOpen({ ...exercise, feedbackWhen: "none" })).toBe(false);
    expect(afterDueOpen({ ...exercise, showKey: false })).toBe(false);
    expect(afterDueOpen({ ...exercise, feedbackWhen: "immediate", showKey: false })).toBe(false);
  });

  it("is open when the teacher says so, the hidden key accepted", () => {
    expect(afterDueOpen({ ...exercise, showKey: false, afterDue: "open" })).toBe(true);
  });

  it("follows the teacher's switch when set, the policy none included", () => {
    expect(afterDueOpen({ ...exercise, afterDue: "hidden" })).toBe(false);
    expect(afterDueOpen({ ...exercise, feedbackWhen: "none", afterDue: "open" })).toBe(true);
  });

  it("is never open on an exam or a poll", () => {
    expect(afterDueOpen({ ...exercise, mode: "exam", afterDue: "open" })).toBe(false);
    expect(afterDueOpen({ ...exercise, mode: "poll", afterDue: "open" })).toBe(false);
  });

  it("is hidden on an exercise that asks for a trusted client", () => {
    expect(afterDueOpen({ ...exercise, afterDue: "open", safeExamBrowser: true })).toBe(false);
    expect(afterDueOpen({ ...exercise, kiosk: true })).toBe(false);
  });
});

describe("practiceDeadline (ADR-122 §3)", () => {
  const startedAt = new Date("2026-11-02T10:00:00Z");

  it("is the exercise's own time limit, never cut at its closing", () => {
    const at = practiceDeadline({ startedAt, timing: "duration", durationS: 1800, timeBonusPercent: 0 });
    expect(at.toISOString()).toBe("2026-11-02T10:30:00.000Z");
  });

  it("adds the student's accommodation to that limit", () => {
    const at = practiceDeadline({ startedAt, timing: "duration", durationS: 1800, timeBonusPercent: 50 });
    expect(at.toISOString()).toBe("2026-11-02T10:45:00.000Z");
  });

  it("is eight hours without a time limit of its own", () => {
    for (const timing of ["deadline", "manual"] as const) {
      const at = practiceDeadline({ startedAt, timing, durationS: null, timeBonusPercent: 25 });
      expect(at.getTime() - startedAt.getTime()).toBe(PRACTICE_DEFAULT_S * 1000);
    }
    expect(practiceDurationS({ timing: "deadline", durationS: 600 })).toBe(PRACTICE_DEFAULT_S);
    expect(practiceDurationS({ timing: "duration", durationS: 600 })).toBe(600);
    expect(practiceOwnLimit({ timing: "duration", durationS: null })).toBe(false);
    expect(practiceOwnLimit({ timing: "duration", durationS: 0 })).toBe(false);
  });
});

describe("practiceRefusal (ADR-122 §5)", () => {
  const ok = { open: true, evaluationState: "closed" as const, archived: false, unfinishedOfficial: false };

  it("lets a practice attempt start on an exercise that is over", () => {
    for (const evaluationState of ["closed", "grading", "released"] as const) {
      expect(practiceRefusal({ ...ok, evaluationState })).toBeNull();
    }
  });

  it("refuses, in order: hidden, not over, archived, an unfinished attempt", () => {
    expect(practiceRefusal({ ...ok, open: false, evaluationState: "running" })).toBe("hidden");
    expect(practiceRefusal({ ...ok, evaluationState: "running", archived: true })).toBe("not_over");
    expect(practiceRefusal({ ...ok, archived: true, unfinishedOfficial: true })).toBe("archived");
    expect(practiceRefusal({ ...ok, unfinishedOfficial: true })).toBe("unfinished");
  });
});

describe("practiceCooldownS", () => {
  const now = new Date("2026-11-02T10:00:30Z");
  it("waits out the minute after the latest practice attempt", () => {
    expect(practiceCooldownS(null, now)).toBe(0);
    expect(practiceCooldownS(new Date("2026-11-02T10:00:00Z"), now)).toBe(30);
    expect(practiceCooldownS(new Date("2026-11-02T09:59:30Z"), now)).toBe(0);
  });
});

describe("gradableNow and a practice attempt", () => {
  it("grades a practice attempt once it is finished, whatever the state", () => {
    expect(gradableNow("closed", { state: "in_progress", afterDue: true })).toBe(false);
    expect(gradableNow("released", { state: "submitted", afterDue: true })).toBe(true);
    // An official attempt keeps its rule.
    expect(gradableNow("closed", { state: "in_progress", afterDue: false })).toBe(true);
  });
});
