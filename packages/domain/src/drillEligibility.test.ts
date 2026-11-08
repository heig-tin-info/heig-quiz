import { QUESTION_TYPE_IDS, type GradeResult } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { isDrillEligible } from "./drillEligibility.js";

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
  it("takes exactly the five types of the v1 scope, graded automatically and finally (ADR-041 §3)", () => {
    const taken = QUESTION_TYPE_IDS.filter((id) => isDrillEligible(id, graded()));
    expect(taken).toEqual(["mcq", "short", "cloze", "categorize", "blocks"]);
    expect(QUESTION_TYPE_IDS.filter((id) => isDrillEligible(id, graded("validated")))).toEqual(taken);
  });

  it("refuses a grading that waits: an LLM, or a proposal for the teacher", () => {
    expect(isDrillEligible("short", pendingLlm)).toBe(false);
    expect(isDrillEligible("short", graded("proposed"))).toBe(false);
  });
});
