import { describe, expect, it } from "vitest";

import { mergeCategorize } from "./generate.js";
import { CategorizeConfigSchema, emptyCategorizeDraft, type CategorizeConfig } from "./schema.js";

/** Each column's label with the texts of its cards, and the unplaced cards. */
function shape(config: CategorizeConfig) {
  const text = new Map(config.cards.map((c) => [c.id, c.text]));
  const placed = new Set(config.columns.flatMap((c) => c.cards));
  return {
    columns: config.columns.map((c) => [c.label, c.cards.map((id) => text.get(id))]),
    loose: config.cards.filter((c) => !placed.has(c.id)).map((c) => c.text),
  };
}

describe("mergeCategorize", () => {
  it("names the empty columns of a fresh draft, places the cards, and gives a valid config", () => {
    const merged = mergeCategorize(
      { ...emptyCategorizeDraft(), prompt: "Sort the animals." },
      {
        columns: [
          { label: "Mammals", cards: ["Cat", "Whale"] },
          { label: "Birds", cards: ["Owl"] },
          { label: "Fish", cards: ["Trout"] },
        ],
        distractors: ["Rock"],
      },
    );
    expect(shape(merged)).toEqual({
      columns: [
        ["Mammals", ["Cat", "Whale"]],
        ["Birds", ["Owl"]],
        ["Fish", ["Trout"]],
      ],
      loose: ["Rock"],
    });
    expect(CategorizeConfigSchema.safeParse(merged).success).toBe(true);
  });

  it("joins the teacher's column of the same label, and never adds nor moves a card they hold", () => {
    const before: CategorizeConfig = {
      ...emptyCategorizeDraft(),
      prompt: "Sort.",
      columns: [
        { id: "col0aaaa", label: "Birds", cards: ["card0aaa"] },
        { id: "col1aaaa", label: "", cards: [] },
      ],
      cards: [{ id: "card0aaa", text: "Owl" }],
    };
    const merged = mergeCategorize(before, {
      columns: [
        { label: "birds", cards: ["owl", "Eagle"] },
        { label: "Fish", cards: ["Owl", "Trout"] },
      ],
      distractors: [],
    });
    expect(shape(merged).columns).toEqual([
      ["Birds", ["Owl", "Eagle"]],
      ["Fish", ["Trout"]],
    ]);
    expect(merged.columns[0]!.id).toBe("col0aaaa");
  });
});
