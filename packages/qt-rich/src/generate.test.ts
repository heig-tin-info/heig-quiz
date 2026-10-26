import { describe, expect, it } from "vitest";

import { mergeRich, richGenerator } from "./generate.js";
import { emptyRichDraft } from "./schema.js";

describe("mergeRich", () => {
  it("fills an empty model answer and an empty rubric", () => {
    const merged = mergeRich({ ...emptyRichDraft(), prompt: "Why?" }, { reference: "Because.", rubric: "- the cause (2 pts)", criteria: [] });
    expect(merged).toMatchObject({ reference: "Because.", rubric: "- the cause (2 pts)", criteria: [] });
  });

  it("never touches what the teacher wrote", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?", rubric: "Mine" };
    expect(mergeRich(before, { reference: "", rubric: "Theirs", criteria: [] })).toEqual(before);
  });

  it("ignores an empty proposal, and caps what it writes at the schema's lengths", () => {
    const before = { ...emptyRichDraft(), prompt: "Why?" };
    expect(mergeRich(before, { reference: "  ", rubric: "", criteria: [] })).toEqual(before);
    const long = mergeRich(before, { reference: "x".repeat(60_000), rubric: "y".repeat(30_000), criteria: [] });
    expect(long.reference).toHaveLength(50_000);
    expect(long.rubric).toHaveLength(20_000);
  });

  it("fills criteria only when there are none, each with a fresh id and a whole weight", () => {
    const proposal = {
      reference: "",
      rubric: "",
      criteria: [
        { title: " Names the cause ", weight: 2.4, prompt: "Says why." },
        { title: "  ", weight: 1, prompt: "dropped" },
        { title: "Gives an example", weight: 0, prompt: "" },
      ],
    };
    const merged = mergeRich({ ...emptyRichDraft(), prompt: "Why?" }, proposal);
    expect(merged.criteria).toMatchObject([
      { title: "Names the cause", weight: 2, prompt: "Says why." },
      { title: "Gives an example", weight: 1, prompt: "" },
    ]);
    const [a, b] = merged.criteria;
    expect(a!.id).toMatch(/^[a-z0-9]{8}$/);
    expect(a!.id).not.toBe(b!.id);
    const mine = { ...emptyRichDraft(), prompt: "Why?", criteria: [{ id: "m", title: "Mine", weight: 3, prompt: "" }] };
    expect(mergeRich(mine, proposal).criteria).toEqual(mine.criteria);
  });

  it("tells the model the grader's contract", () => {
    expect(richGenerator.instructions).toMatch(/from 0 to its weight in quarter points/);
  });

  it("reads a draft whose fields are missing (D16)", () => {
    const draft = { prompt: "Why?" } as Parameters<typeof mergeRich>[0];
    expect(mergeRich(draft, { reference: "R", rubric: "C", criteria: [] })).toMatchObject({ reference: "R", rubric: "C" });
  });

  it("reads the statement, empty when the draft has none", () => {
    expect(richGenerator.statement({ ...emptyRichDraft(), prompt: "Why?" })).toBe("Why?");
    expect(richGenerator.statement({} as Parameters<typeof mergeRich>[0])).toBe("");
  });
});
