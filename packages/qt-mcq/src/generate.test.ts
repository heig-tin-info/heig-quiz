import { describe, expect, it } from "vitest";

import { mcqGenerator, mergeMcq } from "./generate.js";
import { emptyMcqDraft, type McqConfig } from "./schema.js";

const draft = (choices: McqConfig["choices"], mode: McqConfig["mode"] = "single"): McqConfig => ({
  ...emptyMcqDraft(),
  prompt: "2 + 2 ?",
  mode,
  choices,
});

describe("mergeMcq", () => {
  it("fills the empty rows of a fresh draft, then appends", () => {
    const merged = mergeMcq(emptyMcqDraft(), {
      choices: [
        { text: "4", correct: true },
        { text: "3", correct: false },
        { text: "5", correct: false },
      ],
    });
    expect(merged.choices).toEqual([
      { text: "4", correct: true },
      { text: "3", correct: false },
      { text: "5", correct: false },
    ]);
  });

  it("keeps every choice the teacher wrote, its tick included, and never repeats one", () => {
    const merged = mergeMcq(
      draft([
        { text: "4", correct: true },
        { text: "", correct: false },
      ]),
      {
        choices: [
          { text: " 4 ", correct: true },
          { text: "22", correct: true },
          { text: "3", correct: false },
        ],
      },
    );
    // `single`: the teacher's tick wins, the proposal's second key is a distractor.
    expect(merged.choices).toEqual([
      { text: "4", correct: true },
      { text: "22", correct: false },
      { text: "3", correct: false },
    ]);
  });

  it("lets several keys through in multiple mode, and stops at twelve choices", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, correct: i < 2 }));
    const merged = mergeMcq(draft([{ text: "a", correct: true }], "multiple"), { choices: many });
    expect(merged.choices).toHaveLength(12);
    expect(merged.choices.filter((c) => c.correct)).toHaveLength(3);
  });

  it("changes nothing but the choices", () => {
    const before = { ...draft([{ text: "", correct: true }]), shuffleChoices: false, policy: "symmetric" as const };
    const merged = mergeMcq(before, { choices: [{ text: "x", correct: true }] });
    expect({ ...merged, choices: before.choices }).toEqual(before);
  });
});

describe("the wand of one choice", () => {
  const item = mcqGenerator.item!;

  it("only fills an empty row that exists", () => {
    const config = draft([
      { text: "4", correct: true },
      { text: "", correct: false },
    ]);
    expect(item.accepts(config, 0)).toBe(false);
    expect(item.accepts(config, 1)).toBe(true);
    expect(item.accepts(config, 2)).toBe(false);
  });

  it("places the choice, and never a second key in single mode", () => {
    const config = draft([
      { text: "4", correct: true },
      { text: "", correct: false },
    ]);
    expect(item.place(config, 1, { text: "5", correct: true }).choices).toEqual([
      { text: "4", correct: true },
      { text: "5", correct: false },
    ]);
  });
});
