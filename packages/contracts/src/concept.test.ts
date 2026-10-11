import { describe, expect, it } from "vitest";

import { ConceptPatch, ConceptResolveQuery, SuggestConceptsRequest } from "./concept.js";
import { GenerateRequest, LLM_CONFIG_MAX_CHARS } from "./llm.js";

describe("ConceptPatch (ADR-081 addendum §5)", () => {
  it("takes either language, or both, and refuses an empty patch", () => {
    expect(ConceptPatch.parse({ en: { label: "loop" } })).toEqual({ en: { label: "loop" } });
    expect(ConceptPatch.parse({ fr: { qualifier: "itération" } })).toEqual({ fr: { qualifier: "itération" } });
    expect(ConceptPatch.safeParse({}).success).toBe(false);
    expect(ConceptPatch.safeParse({ fr: {} }).success).toBe(false);
  });
});

describe("ConceptResolveQuery", () => {
  it("reads one `input` or several, never split on commas", () => {
    expect(ConceptResolveQuery.parse({ input: "pile, file" })).toEqual({ input: ["pile, file"] });
    expect(ConceptResolveQuery.parse({ input: ["pile", "file"] })).toEqual({ input: ["pile", "file"] });
    expect(ConceptResolveQuery.safeParse({ input: [] }).success).toBe(false);
  });
});

describe("the question draft sent to a model (audit L2)", () => {
  it("is bounded in size", () => {
    const config = (chars: number) => ({ text: "x".repeat(chars) });
    expect(SuggestConceptsRequest.safeParse({ config: config(1000) }).success).toBe(true);
    expect(SuggestConceptsRequest.safeParse({ config: config(LLM_CONFIG_MAX_CHARS) }).success).toBe(false);
    const big = GenerateRequest.safeParse({ config: config(LLM_CONFIG_MAX_CHARS), explanation: "" });
    expect(big.success ? null : big.error.issues[0]!.message).toBe("config_too_large");
    expect(GenerateRequest.safeParse({ config: undefined, explanation: "" }).success).toBe(true);
  });
});
