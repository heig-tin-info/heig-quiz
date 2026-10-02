import { describe, expect, it } from "vitest";

import { editableProjectFields, PROJECT_PATCH_FIELDS, projectFieldRefusal, type ProjectLifeLike } from "./projectPatch.js";

const NOW = new Date("2026-10-02T10:00:00Z");
const LATER = new Date("2026-10-20T22:00:00Z");
const EARLIER = new Date("2026-10-01T22:00:00Z");

const project = (over: Partial<ProjectLifeLike> = {}): ProjectLifeLike => ({
  state: "published",
  deadlineAt: LATER,
  ...over,
});

describe("projectFieldRefusal (F-PROJ-03)", () => {
  it("lets a draft change everything", () => {
    expect(editableProjectFields(project({ state: "draft", deadlineAt: EARLIER }), NOW)).toEqual([...PROJECT_PATCH_FIELDS]);
  });

  it("keeps the name, the protected files, the deadline and its strategy open once published", () => {
    expect(editableProjectFields(project(), NOW)).toEqual(["name", "deadlineAt", "deadlineStrategy", "protectedFiles"]);
  });

  it("freezes the publication mode and its duration at publication", () => {
    expect(projectFieldRefusal(project(), "publishMode", NOW)).toBe("publish_mode_frozen");
    expect(projectFieldRefusal(project(), "durationMinutes", NOW)).toBe("publish_mode_frozen");
  });

  it("freezes the grace, the grading, the start and the groups at publication (ADR-048)", () => {
    for (const field of ["startAt", "graceMinutes", "gradingMode", "gradingScale", "groupMode", "groupMaxSize"] as const) {
      expect(projectFieldRefusal(project(), field, NOW), field).toBe("not_draft");
    }
  });

  it("freezes the deadline strategy at the deadline, applied or not", () => {
    expect(projectFieldRefusal(project({ deadlineAt: NOW }), "deadlineStrategy", NOW)).toBe("strategy_frozen");
    expect(projectFieldRefusal(project({ state: "locked" }), "deadlineStrategy", NOW)).toBe("strategy_frozen");
  });

  it("still moves a deadline already applied: the reopen (M3-05a)", () => {
    expect(projectFieldRefusal(project({ state: "locked", deadlineAt: EARLIER }), "deadlineAt", NOW)).toBeNull();
    expect(projectFieldRefusal(project({ state: "locked" }), "deadlineAt", NOW)).toBeNull();
    expect(editableProjectFields(project({ state: "locked", deadlineAt: EARLIER }), NOW)).toEqual(["name", "deadlineAt", "protectedFiles"]);
  });
});
