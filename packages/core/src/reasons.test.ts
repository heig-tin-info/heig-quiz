import { describe, expect, it } from "vitest";

import { aiOf, isMachineReason, isRetryableReason, justificationOf, reasonOf } from "./reasons.js";

describe("the machine reasons of a grading", () => {
  it("knows its own codes, and which of them a new pass may clear", () => {
    expect(isMachineReason("llm_budget")).toBe(true);
    expect(isMachineReason("nonsense")).toBe(false);
    expect(isMachineReason(3)).toBe(false);
    expect(isRetryableReason("llm_budget")).toBe(true);
    expect(isRetryableReason("llm_not_configured")).toBe(false);
    expect(isRetryableReason(null)).toBe(false);
  });

  it("reads `details.reason` when it is a string, else nothing", () => {
    expect(reasonOf({ reason: "grader_error" })).toBe("grader_error");
    expect(reasonOf({ reason: 1 })).toBeNull();
    expect(reasonOf({})).toBeNull();
    expect(reasonOf(null)).toBeNull();
  });
});

describe("an LLM's reply in the details (ADR-045, ADR-063)", () => {
  const ai = { model: "claude-sonnet-5-5", criteria: [{ criterion: "c", points: 1, maxPoints: 2, comment: "half" }] };

  it("reads the justification when it is a string", () => {
    expect(justificationOf({ justification: "why" })).toBe("why");
    expect(justificationOf({ justification: 2 })).toBeNull();
    expect(justificationOf({})).toBeNull();
    expect(justificationOf(null)).toBeNull();
  });

  it("reads the criteria and the model when they have the shape", () => {
    expect(aiOf({ ai })).toEqual(ai);
    expect(aiOf({ ai: { model: "m" } })).toBeNull();
    expect(aiOf({ ai: null })).toBeNull();
    expect(aiOf({})).toBeNull();
    expect(aiOf(null)).toBeNull();
  });
});
