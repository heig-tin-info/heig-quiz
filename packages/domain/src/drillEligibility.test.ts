import type { GradeResult } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { DRILL_TYPES, isDrillEligible } from "./drillEligibility.js";

const graded = (state?: "validated" | "proposed"): GradeResult => ({
  kind: "graded",
  points: 1,
  maxPoints: 1,
  details: {},
  ...(state ? { state } : {}),
});
const pendingLlm: GradeResult = {
  kind: "pending",
  via: "llm",
  request: { statement: "s", form: "free text", rubric: "r", answer: "a", maxPoints: 1 },
};

describe("isDrillEligible", () => {
  it("scopes v1 to four types", () => {
    expect(DRILL_TYPES).toEqual(["mcq", "short", "cloze", "categorize"]);
  });

  it("takes a v1 type whose grading is automatic and final", () => {
    expect(isDrillEligible("mcq", graded())).toBe(true);
    expect(isDrillEligible("categorize", graded("validated"))).toBe(true);
  });

  it("refuses a grading that waits: an LLM, or a proposal for the teacher", () => {
    expect(isDrillEligible("short", pendingLlm)).toBe(false);
    expect(isDrillEligible("short", graded("proposed"))).toBe(false);
  });

  it("refuses a type outside the scope, however it is graded", () => {
    expect(isDrillEligible("rich", graded())).toBe(false);
    expect(isDrillEligible("code", graded())).toBe(false);
    expect(isDrillEligible("diagram", graded())).toBe(false);
  });
});
