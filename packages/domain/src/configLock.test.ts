import { describe, expect, it } from "vitest";

import {
  configLock,
  isConfigEditable,
  isConfigFieldWritable,
  negativeMarkingAllowedFor,
  negativeMarkingOn,
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

  it("leaves only the title, the access control and the feedback writable during a run", () => {
    const fields = [
      "title",
      "accessCode",
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
      "accessCode",
      "ipAllowlist",
      "feedbackPolicy",
    ]);
    expect(fields.filter((f) => isConfigFieldWritable("attempts", f))).toEqual([
      "title",
      "accessCode",
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

  it("concerns the choice questions only", () => {
    expect(scoresNegatively("mcq", true)).toBe(true);
    expect(scoresNegatively("mcq", false)).toBe(false);
    for (const type of ["short", "cloze", "code", "codeimage", "circuit"]) {
      expect(scoresNegatively(type, true), type).toBe(false);
    }
  });

  it("is frozen with the rest of the settings", () => {
    // `settings` is structural: locked by the run and by the first attempt.
    expect(isConfigFieldWritable("running", "settings")).toBe(false);
    expect(isConfigFieldWritable("attempts", "settings")).toBe(false);
  });
});
