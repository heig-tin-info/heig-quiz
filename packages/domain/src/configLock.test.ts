import { describe, expect, it } from "vitest";

import {
  allowDrillWritable,
  configLock,
  drillAllowedOn,
  isConfigEditable,
  isConfigFieldWritable,
  negativeMarkingAllowedFor,
  negativeMarkingOn,
  safeExamBrowserOn,
  scoresNegatively,
} from "./evaluationConfig.js";
import { EVALUATION_STATES } from "./itemList.js";

describe("configLock (#86)", () => {
  it("locks a running or paused evaluation even while nobody has entered", () => {
    expect(configLock("running", 0)).toBe("running");
    expect(configLock("paused", 0)).toBe("running");
    expect(configLock("running", 4)).toBe("running");
  });

  it("falls back to the attempt rule outside a run", () => {
    for (const state of EVALUATION_STATES.filter((s) => s !== "running" && s !== "paused")) {
      expect(configLock(state, 0), state).toBeNull();
      expect(configLock(state, 2), state).toBe("attempts");
    }
  });

  it("leaves only the title, the allowlist and the feedback writable during a run", () => {
    const fields = [
      "title",
      "ipAllowlist",
      "feedbackPolicy",
      "settings",
      "durationS",
      "opensAt",
      "closesAt",
      "gradingScale",
      "mcqPolicy",
    ];
    expect(fields.filter((f) => isConfigFieldWritable("running", f))).toEqual([
      "title",
      "ipAllowlist",
      "feedbackPolicy",
    ]);
    expect(fields.filter((f) => isConfigFieldWritable("attempts", f))).toEqual([
      "title",
      "ipAllowlist",
      "feedbackPolicy",
    ]);
    expect(fields.every((f) => isConfigFieldWritable(null, f))).toBe(true);
  });

  it("calls the configuration editable only when nothing locks it", () => {
    expect(isConfigEditable("draft", 0)).toBe(true);
    expect(isConfigEditable("lobby", 0)).toBe(true);
    expect(isConfigEditable("running", 0)).toBe(false);
    expect(isConfigEditable("closed", 1)).toBe(false);
  });
});

describe("Safe Exam Browser (ADR-027)", () => {
  it("is on only when set on an exam", () => {
    expect(safeExamBrowserOn("exam", true)).toBe(true);
    expect(safeExamBrowserOn("exam", undefined)).toBe(false);
    expect(safeExamBrowserOn("exercise", true)).toBe(false);
    expect(safeExamBrowserOn("poll", true)).toBe(false);
  });
});

describe("negative marking (ADR-026)", () => {
  it("is allowed on an exam and an exercise, never on a poll", () => {
    expect(negativeMarkingAllowedFor("exam")).toBe(true);
    expect(negativeMarkingAllowedFor("exercise")).toBe(true);
    expect(negativeMarkingAllowedFor("poll")).toBe(false);
  });

  it("is on only when set, and never on a poll", () => {
    expect(negativeMarkingOn("exam", true)).toBe(true);
    expect(negativeMarkingOn("exam", false)).toBe(false);
    expect(negativeMarkingOn("exercise", undefined)).toBe(false);
    expect(negativeMarkingOn("poll", true)).toBe(false);
  });

  it("concerns the choice questions only: mcq and categorize (ADR-036)", () => {
    for (const type of ["mcq", "categorize"]) {
      expect(scoresNegatively(type, true, false), type).toBe(true);
      expect(scoresNegatively(type, false, false), type).toBe(false);
    }
    for (const type of ["short", "cloze", "code", "codeimage", "circuit", "rich"]) {
      expect(scoresNegatively(type, true, false), type).toBe(false);
    }
  });

  it("never lets a bonus item score below 0 (ADR-052)", () => {
    expect(scoresNegatively("mcq", true, true)).toBe(false);
    expect(scoresNegatively("mcq", true, false)).toBe(true);
  });

  it("is frozen with the rest of the settings", () => {
    // `settings` is structural: locked by the run and by the first attempt.
    expect(isConfigFieldWritable("running", "settings")).toBe(false);
    expect(isConfigFieldWritable("attempts", "settings")).toBe(false);
  });
});

describe("drillAllowedOn (ADR-041 §2)", () => {
  it("defaults to on for an exercise and off for an exam", () => {
    expect(drillAllowedOn("exercise", undefined)).toBe(true);
    expect(drillAllowedOn("exam", undefined)).toBe(false);
  });

  it("follows the teacher's choice either way", () => {
    expect(drillAllowedOn("exam", true)).toBe(true);
    expect(drillAllowedOn("exercise", false)).toBe(false);
  });

  it("never allows a poll, whatever its row says", () => {
    expect(drillAllowedOn("poll", true)).toBe(false);
    expect(drillAllowedOn("poll", undefined)).toBe(false);
  });
});

describe("allowDrillWritable (ADR-041 §10, item 3)", () => {
  it("stays writable until the release, whatever else is frozen", () => {
    for (const state of ["draft", "scheduled", "lobby", "running", "paused", "closed", "grading"] as const) {
      expect(allowDrillWritable("exam", state)).toBe(true);
      expect(allowDrillWritable("exercise", state)).toBe(true);
    }
  });

  it("freezes at the release", () => {
    expect(allowDrillWritable("exam", "released")).toBe(false);
    expect(allowDrillWritable("exercise", "released")).toBe(false);
  });

  it("is never writable on a poll", () => {
    expect(allowDrillWritable("poll", "draft")).toBe(false);
  });
});
