import { describe, expect, it } from "vitest";

import { mergeRich, richGenerator } from "./generate.js";
import { emptyRichDraft } from "./schema.js";

describe("mergeRich", () => {
  it("fills an empty model answer and an empty rubric", () => {
    const merged = mergeRich({ ...emptyRichDraft(), prompt: "Why?" }, { reference: "Because.", rubric: "- the cause (2 pts)" });
    expect(merged).toMatchObject({ reference: "Because.", rubric: "- the cause (2 pts)" });
  });

  it("never touches what the teacher wrote", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?", rubric: "Mine" };
    expect(mergeRich(before, { reference: "", rubric: "Theirs" })).toEqual(before);
  });

  it("ignores an empty proposal, and caps what it writes at the schema's lengths", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?" };
    expect(mergeRich(before, { reference: "  ", rubric: "" })).toEqual(before);
    const long = mergeRich(before, { reference: "x".repeat(60_000), rubric: "y".repeat(30_000) });
    expect(long.reference).toHaveLength(50_000);
    expect(long.rubric).toHaveLength(20_000);
  });

  it("reads a draft whose fields are missing (D16)", () => {
    const draft = { prompt: "Why?" } as Parameters<typeof mergeRich>[0];
    expect(mergeRich(draft, { reference: "R", rubric: "C" })).toMatchObject({ reference: "R", rubric: "C" });
  });

  it("reads the statement, empty when the draft has none", () => {
    expect(richGenerator.statement({ ...emptyRichDraft(), prompt: "Why?" })).toBe("Why?");
    expect(richGenerator.statement({} as Parameters<typeof mergeRich>[0])).toBe("");
  });
});
