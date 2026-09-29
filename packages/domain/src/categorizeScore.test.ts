import { describe, expect, it } from "vitest";

import { categorizeFraction, type CategorizeScoreInput } from "./categorizeScore.js";

const base = { T: 8, D: 1, k: 3, policy: "per_item" } as const;
const score = (over: Partial<CategorizeScoreInput> & Pick<CategorizeScoreInput, "t" | "x" | "p">) =>
  categorizeFraction({ ...base, ...over });

describe("categorizeFraction", () => {
  it("per_item: every card is 1/n, a distractor left out counts", () => {
    expect(score({ t: 8, x: 0, p: 0 })).toBe(1);
    expect(score({ t: 6, x: 2, p: 0 })).toBeCloseTo(7 / 9);
    expect(score({ t: 6, x: 1, p: 1 })).toBeCloseTo(6 / 9);
  });

  it("an answer that places nothing is worth 0, even with distractors", () => {
    expect(score({ t: 0, x: 0, p: 0 })).toBe(0);
    expect(score({ t: 0, x: 0, p: 0, policy: "all_or_nothing" })).toBe(0);
  });

  it("a single placed card is enough for the distractors to count", () => {
    expect(score({ t: 1, x: 0, p: 0 })).toBeCloseTo(2 / 9);
  });

  it("all_or_nothing: every target placed and no distractor", () => {
    expect(score({ t: 8, x: 0, p: 0, policy: "all_or_nothing" })).toBe(1);
    expect(score({ t: 8, x: 0, p: 1, policy: "all_or_nothing" })).toBe(0);
    expect(score({ t: 7, x: 1, p: 0, policy: "all_or_nothing" })).toBe(0);
  });

  it("negative marking: +1 per target, −1/(k−1) per wrong card, over T, not floored", () => {
    expect(score({ t: 8, x: 0, p: 0, negativeMarking: true })).toBe(1);
    expect(score({ t: 6, x: 2, p: 0, negativeMarking: true })).toBeCloseTo((6 - 1) / 8);
    expect(score({ t: 0, x: 8, p: 1, negativeMarking: true })).toBeCloseTo(-4.5 / 8);
    expect(score({ t: 0, x: 0, p: 0, negativeMarking: true })).toBe(0);
    expect(score({ t: 0, x: 8, p: 1, k: 2, negativeMarking: true })).toBe(-1);
  });

  it("negative marking: placing a target at random has an expected value of 0", () => {
    for (const k of [2, 3, 5]) {
      // One target among k columns: right with 1/k, wrong otherwise.
      const expected =
        (1 / k) * categorizeFraction({ T: 1, D: 0, k, t: 1, x: 0, p: 0, policy: "per_item", negativeMarking: true }) +
        ((k - 1) / k) *
          categorizeFraction({ T: 1, D: 0, k, t: 0, x: 1, p: 0, policy: "per_item", negativeMarking: true });
      expect(expected).toBeCloseTo(0);
    }
  });

  it("stays total on a config without targets", () => {
    expect(categorizeFraction({ T: 0, D: 2, k: 2, t: 0, x: 0, p: 1, policy: "per_item" })).toBe(0);
  });
});
