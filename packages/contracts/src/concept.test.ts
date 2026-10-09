import { describe, expect, it } from "vitest";

import { ConceptPatch, ConceptResolveQuery } from "./concept.js";

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
