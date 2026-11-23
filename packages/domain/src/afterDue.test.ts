import { describe, expect, it } from "vitest";

import {
  afterDueOpen,
  afterDueRefusal,
  afterDueSettingOf,
  PRACTICE_BY_MODE,
  practiceFeedsDrill,
  practiceIgnoresSittingConditions,
  practiceKeyShown,
  practicePrintable,
  takenBy,
  PRACTICE_DEFAULT_S,
  practiceCooldownS,
  practiceDeadline,
  practiceDurationS,
  practiceOwnLimit,
  practiceRefusal,
} from "./afterDue.js";
import { gradableNow } from "./retake.js";

const exercise = { mode: "exercise" as const, afterDue: undefined, feedback: { when: "none" as const, showKey: false } };

describe("afterDueOpen (ADR-122 §1, ADR-124)", () => {
  it("is open by default on every exercise: its key is shown at the hand-in anyway", () => {
    expect(afterDueOpen(exercise)).toBe(true);
  });

  it("follows the teacher's switch when set", () => {
    expect(afterDueOpen({ ...exercise, afterDue: "hidden" })).toBe(false);
    expect(afterDueOpen({ ...exercise, afterDue: "open" })).toBe(true);
  });

  it("is never open on a poll", () => {
    expect(afterDueOpen({ ...exercise, mode: "poll", afterDue: "open" })).toBe(false);
  });

  it("is hidden on an exercise that asks for a trusted client", () => {
    expect(afterDueOpen({ ...exercise, afterDue: "open", safeExamBrowser: true })).toBe(false);
    expect(afterDueOpen({ ...exercise, kiosk: true })).toBe(false);
  });
});

describe("an exam's practice (ADR-142)", () => {
  const shown = { when: "on_release" as const, showKey: true };
  const exam = { mode: "exam" as const, afterDue: "open" as const, feedback: shown };

  it("is closed by default, open only when the teacher set it", () => {
    expect(afterDueOpen({ ...exam, afterDue: undefined })).toBe(false);
    expect(afterDueOpen({ ...exam, afterDue: "hidden" })).toBe(false);
    expect(afterDueOpen(exam)).toBe(true);
    expect(afterDueSettingOf("exam", undefined)).toBe("hidden");
    expect(afterDueSettingOf("exercise", undefined)).toBe("open");
    expect(afterDueSettingOf("poll", "open")).toBe("hidden");
  });

  it("closes again when the stored policy stops showing the key at the release", () => {
    expect(afterDueOpen({ ...exam, feedback: { ...shown, showKey: false } })).toBe(false);
    expect(afterDueOpen({ ...exam, feedback: { ...shown, when: "none" } })).toBe(false);
    expect(practiceKeyShown({ ...shown, when: "immediate" })).toBe(false);
  });

  it("ignores the exam's trusted clients: they protect the sitting", () => {
    expect(afterDueOpen({ ...exam, safeExamBrowser: true, kiosk: true })).toBe(true);
    expect(practiceIgnoresSittingConditions("exam")).toBe(true);
    expect(practiceIgnoresSittingConditions("exercise")).toBe(false);
    expect(practiceIgnoresSittingConditions("poll")).toBe(false);
  });

  it("refuses the switch on under a hidden key, never its closing, and always on a poll", () => {
    expect(afterDueRefusal({ ...exam, feedback: { ...shown, showKey: false } })).toBe("key_hidden");
    expect(afterDueRefusal({ ...exam, afterDue: "hidden", feedback: { ...shown, showKey: false } })).toBeNull();
    expect(afterDueRefusal(exam)).toBeNull();
    expect(afterDueRefusal({ ...exam, mode: "exercise", feedback: { ...shown, when: "none" } })).toBeNull();
    expect(afterDueRefusal({ ...exam, mode: "poll" })).toBe("mode");
  });

  it("refuses a student who did not hand it in, and an exam not (or no longer) released", () => {
    const ok = { mode: "exam" as const, open: true, evaluationState: "released" as const, archived: false, taken: true, unfinishedOfficial: false };
    expect(practiceRefusal(ok)).toBeNull();
    expect(practiceRefusal({ ...ok, taken: false })).toBe("not_taken");
    for (const evaluationState of ["closed", "grading", "running"] as const) {
      expect(practiceRefusal({ ...ok, evaluationState })).toBe("not_released");
    }
    expect(practiceRefusal({ ...ok, archived: true, taken: false })).toBe("archived");
    // An exercise asks nobody to have handed it in; a poll takes no practice.
    expect(practiceRefusal({ ...ok, mode: "exercise", taken: false })).toBeNull();
    expect(practiceRefusal({ ...ok, mode: "poll" })).toBe("hidden");
  });

  it("counts as taken a finished official attempt only", () => {
    const official = { state: "submitted", afterDue: false, supersededBy: null };
    expect(takenBy([official])).toBe(true);
    expect(takenBy([])).toBe(false);
    expect(takenBy([{ ...official, state: "in_progress" }])).toBe(false);
    expect(takenBy([{ ...official, afterDue: true }])).toBe(false);
    expect(takenBy([{ ...official, supersededBy: "paper" }])).toBe(false);
  });

  it("prints an exercise's past series only, and lets only an exercise's practice feed the drill", () => {
    expect([practicePrintable("exercise"), practicePrintable("exam"), practicePrintable("poll")]).toEqual([true, false, false]);
    expect([practiceFeedsDrill("exercise"), practiceFeedsDrill("exam"), practiceFeedsDrill("poll")]).toEqual([true, false, false]);
    // A mode that asks who took it never hands its series out blank.
    for (const policy of Object.values(PRACTICE_BY_MODE)) {
      if (policy?.needsTaken) expect(policy.printable).toBe(false);
    }
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
  const ok = { mode: "exercise" as const, open: true, evaluationState: "closed" as const, archived: false, taken: false, unfinishedOfficial: false };

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
