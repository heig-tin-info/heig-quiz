import { describe, expect, it } from "vitest";

import { GenerateRequest } from "./llm.js";

describe("GenerateRequest's target (ADR-118)", () => {
  const draft = { config: { prompt: "Why?" }, explanation: "" };

  it("takes a criterion's prompt by id, or the rubric's conversion", () => {
    expect(GenerateRequest.parse({ ...draft, target: { kind: "criterionPrompt", criterionId: "a1" } }).target).toEqual({
      kind: "criterionPrompt",
      criterionId: "a1",
    });
    expect(GenerateRequest.parse({ ...draft, target: { kind: "criteriaFromRubric" } }).target).toEqual({
      kind: "criteriaFromRubric",
    });
    expect(GenerateRequest.parse(draft).target).toBeUndefined();
  });

  it("refuses an unknown kind, a missing id and a stray key", () => {
    expect(GenerateRequest.safeParse({ ...draft, target: { kind: "variant" } }).success).toBe(false);
    expect(GenerateRequest.safeParse({ ...draft, target: { kind: "criterionPrompt" } }).success).toBe(false);
    expect(GenerateRequest.safeParse({ ...draft, target: { kind: "criterionPrompt", criterionId: "" } }).success).toBe(false);
    expect(GenerateRequest.safeParse({ ...draft, target: { kind: "criteriaFromRubric", criterionId: "a" } }).success).toBe(false);
  });

  it("is never asked together with an element", () => {
    const both = GenerateRequest.safeParse({ ...draft, item: 0, target: { kind: "criteriaFromRubric" } });
    expect(both.success ? null : both.error.issues[0]!.message).toBe("item_or_target");
  });
});
