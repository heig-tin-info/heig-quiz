import { describe, expect, it } from "vitest";

import { GenerateRequest } from "./llm.js";

describe("GenerateRequest's target (ADR-118)", () => {
  const draft = { config: { prompt: "Why?" }, explanation: "" };

  it("takes a kind, and the id of the element it is about", () => {
    expect(GenerateRequest.parse({ ...draft, target: { kind: "criterionPrompt", id: "a1" } }).target).toEqual({
      kind: "criterionPrompt",
      id: "a1",
    });
    expect(GenerateRequest.parse({ ...draft, target: { kind: "criteriaFromRubric" } }).target).toEqual({
      kind: "criteriaFromRubric",
    });
    expect(GenerateRequest.parse(draft).target).toBeUndefined();
  });

  it("bounds the spelling of a kind and an id, and refuses a stray key", () => {
    for (const target of [
      { kind: "" },
      { kind: "Constructor" },
      { kind: "__proto__" },
      { kind: "x".repeat(41) },
      { kind: "criterionPrompt", id: "" },
      { kind: "criterionPrompt", id: "a/b" },
      { kind: "criterionPrompt", criterionId: "a" },
    ]) {
      expect(GenerateRequest.safeParse({ ...draft, target }).success).toBe(false);
    }
  });

  it("is never asked together with an element", () => {
    const both = GenerateRequest.safeParse({ ...draft, item: 0, target: { kind: "criteriaFromRubric" } });
    expect(both.success ? null : both.error.issues[0]!.message).toBe("item_or_target");
  });
});
