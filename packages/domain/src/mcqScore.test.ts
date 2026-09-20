import { describe, expect, it } from "vitest";
import { mcqFraction, truncateSelection, type McqPolicy, type McqScoreInput } from "./mcqScore.js";

/** Four choices, two of them correct: C = 2, W = 2. */
const base = {
  correct: [0, 1],
  choiceCount: 4,
  penalty: 0.5,
  allowNegative: false,
} satisfies Omit<McqScoreInput, "selected" | "policy">;

const SELECTIONS: [label: string, selected: number[]][] = [
  ["all right", [0, 1]],
  ["all wrong", [2, 3]],
  ["partial", [0]],
  ["nothing selected", []],
  ["everything selected", [0, 1, 2, 3]],
];

const EXPECTED: Record<McqPolicy, number[]> = {
  //            all right, all wrong, partial, nothing, everything
  all_or_nothing: [1, 0, 0, 0, 0],
  partial: [1, 0, 0.5, 0, 0],
  penalized: [1, 0, 0.5, 0, 0.5],
};

describe("mcqFraction", () => {
  for (const policy of Object.keys(EXPECTED) as McqPolicy[]) {
    it(`scores the five selections under ${policy}`, () => {
      SELECTIONS.forEach(([, selected], i) => {
        expect(mcqFraction({ ...base, selected, policy }).fraction).toBeCloseTo(
          EXPECTED[policy][i]!,
          10,
        );
      });
    });
  }

  it("reports the c / w / C / W counters", () => {
    const score = mcqFraction({ ...base, selected: [0, 2, 3], policy: "partial" });
    expect(score).toMatchObject({ c: 1, w: 2, C: 2, W: 2 });
    expect(score.fraction).toBe(0); // (1 - 2) / 2 = -0.5, clamped to 0
  });

  it("floors at -1 when negatives are allowed", () => {
    const score = mcqFraction({ ...base, selected: [2, 3], policy: "partial", allowNegative: true });
    expect(score.fraction).toBe(-1);
  });

  it("guards W = 0 in the penalized policy", () => {
    const all = mcqFraction({
      correct: [0, 1],
      choiceCount: 2,
      selected: [0],
      policy: "penalized",
      penalty: 1,
      allowNegative: false,
    });
    expect([all.W, all.fraction]).toEqual([0, 0.5]);
  });

  it("stays total when a corrupted row has no correct choice", () => {
    const score = mcqFraction({ ...base, correct: [], selected: [0], policy: "partial" });
    expect(score).toEqual({ fraction: 0, c: 0, w: 1, C: 0, W: 4 });
  });

  it("ignores duplicates in the payload", () => {
    expect(mcqFraction({ ...base, selected: [0, 0, 1], policy: "all_or_nothing" }).fraction).toBe(1);
  });
});

describe("truncateSelection", () => {
  it("keeps the first maxSelections entries and says so", () => {
    expect(truncateSelection([3, 1, 2], 2)).toEqual({ selected: [1, 2], truncated: true });
    expect(truncateSelection([3, 1], 2)).toEqual({ selected: [1, 3], truncated: false });
    expect(truncateSelection([3, 1, 1], null)).toEqual({ selected: [1, 3], truncated: false });
  });
});
