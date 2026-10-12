import { describe, expect, it } from "vitest";

import {
  editableProjectFields,
  gradingModeRefusal,
  patchedDraftDates,
  PROJECT_PATCH_FIELDS,
  projectFieldRefusal,
  type ProjectDatesLike,
  type ProjectLifeLike,
} from "./projectPatch.js";

const NOW = new Date("2026-10-02T10:00:00Z");
const LATER = new Date("2026-10-20T22:00:00Z");
const EARLIER = new Date("2026-10-01T22:00:00Z");

const project = (over: Partial<ProjectLifeLike> = {}): ProjectLifeLike => ({
  state: "published",
  deadlineAt: LATER,
  released: false,
  gradingMode: "auto",
  ...over,
});

describe("projectFieldRefusal (F-PROJ-03)", () => {
  it("lets a draft change everything", () => {
    expect(editableProjectFields(project({ state: "draft", deadlineAt: EARLIER }), NOW)).toEqual([...PROJECT_PATCH_FIELDS]);
  });

  it("keeps the name, the protected files, the deadline and its strategy open once published", () => {
    expect(editableProjectFields(project(), NOW)).toEqual(["name", "deadlineAt", "deadlineStrategy", "protectedFiles", "testsCriterion", "buildCommand", "testCommand", "evidenceOutputs"]);
  });

  it("freezes the publication mode and its duration at publication", () => {
    expect(projectFieldRefusal(project(), "publishMode", NOW)).toBe("publish_mode_frozen");
    expect(projectFieldRefusal(project(), "durationMinutes", NOW)).toBe("publish_mode_frozen");
  });

  it("freezes the grace, the grading, the start and the groups at publication (ADR-048)", () => {
    for (const field of ["startAt", "graceMinutes", "gradingMode", "gradingScale", "groupMode", "groupSetId"] as const) {
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
    expect(editableProjectFields(project({ state: "locked", deadlineAt: EARLIER, released: true }), NOW)).toEqual(["name", "deadlineAt", "protectedFiles", "testsCriterion", "buildCommand", "testCommand", "evidenceOutputs"]);
    // Not released: the grading mode may still go into or out of `criteria` (ADR-106 §1).
    expect(editableProjectFields(project({ state: "locked", deadlineAt: EARLIER }), NOW)).toContain("gradingMode");
  });
});

describe("gradingModeRefusal (ADR-106 §1)", () => {
  it("lets a draft take any mode", () => {
    expect(gradingModeRefusal(project({ state: "draft" }), "none")).toBeNull();
  });

  it("lets an unreleased locked project go into or out of criteria, and nothing else", () => {
    const locked = project({ state: "locked" });
    expect(gradingModeRefusal(locked, "criteria")).toBeNull();
    expect(gradingModeRefusal(locked, "none")).toBe("not_draft");
    expect(gradingModeRefusal(project({ state: "locked", gradingMode: "criteria" }), "auto")).toBeNull();
    expect(projectFieldRefusal(locked, "gradingMode", NOW, "criteria")).toBeNull();
  });

  it("refuses a published project and a released one", () => {
    expect(gradingModeRefusal(project(), "criteria")).toBe("not_draft");
    expect(gradingModeRefusal(project({ state: "locked", released: true }), "criteria")).toBe("released");
  });
});

describe("patchedDraftDates (F-PROJ-03)", () => {
  const manual: ProjectDatesLike = { publishMode: "manual", startAt: EARLIER, deadlineAt: LATER, durationMinutes: null };
  const scheduled: ProjectDatesLike = { publishMode: "scheduled", startAt: new Date("2026-10-10T08:00:00Z"), deadlineAt: LATER, durationMinutes: null };
  const FUTURE = new Date("2026-10-05T08:00:00Z");

  it("keeps a provisional deadline for a duration, from now", () => {
    expect(patchedDraftDates(manual, { durationMinutes: 90 }, NOW)).toEqual({
      ok: true,
      startAt: EARLIER,
      deadlineAt: new Date(NOW.getTime() + 90 * 60_000),
    });
  });

  it("refuses a switch to scheduled that has no start ahead, and a start moved to the past", () => {
    expect(patchedDraftDates(manual, { publishMode: "scheduled" }, NOW)).toEqual({ ok: false, refusal: "start_past" });
    expect(patchedDraftDates(scheduled, { startAt: EARLIER }, NOW)).toEqual({ ok: false, refusal: "start_past" });
    expect(patchedDraftDates(manual, { publishMode: "scheduled", startAt: FUTURE }, NOW)).toEqual({ ok: true, startAt: FUTURE, deadlineAt: LATER });
  });

  it("resets the start to now when back to manual", () => {
    expect(patchedDraftDates(scheduled, { publishMode: "manual" }, NOW)).toEqual({ ok: true, startAt: NOW, deadlineAt: LATER });
  });

  it("refuses a kept deadline that is not ahead on the switch to manual, a past deadline, a duration with a schedule, a deadline before the start", () => {
    const stale = { ...scheduled, startAt: EARLIER, deadlineAt: new Date("2026-10-02T09:00:00Z") };
    expect(patchedDraftDates(stale, { publishMode: "manual" }, NOW)).toEqual({ ok: false, refusal: "deadline_past" });
    expect(patchedDraftDates(manual, { deadlineAt: EARLIER }, NOW)).toEqual({ ok: false, refusal: "deadline_past" });
    expect(patchedDraftDates({ ...manual, durationMinutes: 60 }, { publishMode: "scheduled" }, NOW)).toEqual({ ok: false, refusal: "duration_needs_manual" });
    expect(patchedDraftDates(scheduled, { deadlineAt: FUTURE }, NOW)).toEqual({ ok: false, refusal: "deadline_before_start" });
  });
});
