import { describe, expect, it } from "vitest";

import { relaunchId, sameValue } from "./relaunch";

const ORIGIN = {
  id: "q-1",
  type: "mcq",
  config: {
    prompt: "Which notions have you seen?",
    choices: [
      { text: "Pointers", correct: false },
      { text: "Structs", correct: false },
    ],
    mode: "multiple",
  },
};

describe("relaunchId", () => {
  it("relaunches the same question when nothing changed, key order aside", () => {
    const reordered = {
      mode: "multiple",
      choices: [
        { correct: false, text: "Pointers" },
        { correct: false, text: "Structs" },
      ],
      prompt: "Which notions have you seen?",
    };
    expect(relaunchId(ORIGIN, "mcq", reordered)).toBe("q-1");
  });

  it("starts a new question once the content is edited", () => {
    expect(relaunchId(ORIGIN, "mcq", { ...ORIGIN.config, mode: "single" })).toBeNull();
    const ticked = {
      ...ORIGIN.config,
      choices: [{ text: "Pointers", correct: true }, ORIGIN.config.choices[1]],
    };
    expect(relaunchId(ORIGIN, "mcq", ticked)).toBeNull();
  });

  it("starts a new question for another type, or with no origin", () => {
    expect(relaunchId(ORIGIN, "short", ORIGIN.config)).toBeNull();
    expect(relaunchId(null, "mcq", ORIGIN.config)).toBeNull();
  });
});

describe("sameValue", () => {
  it("treats a key holding undefined as absent", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("tells arrays from objects and lengths apart", () => {
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});
