import { describe, expect, it } from "vitest";

import { mergeRich } from "./generate.js";
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
});
