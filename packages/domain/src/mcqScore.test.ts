import { describe, expect, it } from "vitest";
import { mcqFraction, truncateSelection, type McqScorePolicy, type McqScoreInput } from "./mcqScore.js";

/** Four choices, two of them correct: C = 2, W = 2, n = 4. */
const base = {
  correct: [0, 1],
  choiceCount: 4,
} satisfies Omit<McqScoreInput, "selected" | "policy">;

const SELECTIONS: [label: string, selected: number[]][] = [
  ["both keys", [0, 1]],
  ["both distractors", [2, 3]],
  ["one key", [0]],
  ["one key and one distractor", [0, 2]],
  ["nothing selected", []],
  ["everything selected", [0, 1, 2, 3]],
];

/**
 * The whole truth table of the five policies on one fixture. Each column is
 * hand-computed from the formulas of the module's doc comment; a change to a
 * formula has to change a number here, which is the point.
 */
const EXPECTED: Record<McqScorePolicy, number[]> = {
  //          both keys, both distractors, one key, key+distractor, nothing, everything
  all_or_nothing: [1, 0, 0, 0, 0, 0],
  // (c + (W - w)) / 4
  true_false: [1, 0, 0.75, 0.5, 0.5, 0.5],
  // d = (C - c) + w  ->  0:1, 1:0.5, 2:0.2, 3+:0
  discordance: [1, 0, 0.5, 0.2, 0.2, 0.2],
  // c/C - w/W, floored at 0
  symmetric: [1, 0, 0.5, 0, 0, 0],
  // w > 0 ? 0 : c/C
  ripkey: [1, 0, 0.5, 0, 0, 0],
};

describe("mcqFraction", () => {
  for (const policy of Object.keys(EXPECTED) as McqScorePolicy[]) {
    SELECTIONS.forEach(([label, selected], i) => {
      it(`${policy}: ${label}`, () => {
        expect(mcqFraction({ ...base, selected, policy }).fraction).toBeCloseTo(
          EXPECTED[policy][i]!,
          10,
        );
      });
    });
  }

  it("never leaves [0, 1], whatever the policy", () => {
    for (const policy of Object.keys(EXPECTED) as McqScorePolicy[]) {
      for (const [, selected] of SELECTIONS) {
        const { fraction } = mcqFraction({ ...base, selected, policy });
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reports the c / w / C / W counters", () => {
    const score = mcqFraction({ ...base, selected: [0, 2, 3], policy: "symmetric" });
    expect(score).toMatchObject({ c: 1, w: 2, C: 2, W: 2 });
    expect(score.fraction).toBe(0); // 1/2 - 2/2 = -0.5, floored at 0
  });

  it("gives true_false a mark for every distractor left alone", () => {
    // Nothing ticked: the two distractors are answered right, the two keys wrong.
    expect(mcqFraction({ ...base, selected: [], policy: "true_false" }).fraction).toBe(0.5);
  });

  it("counts a discordance in both directions", () => {
    // One key missed (d = 1) scores the same as one distractor ticked (d = 1).
    const missed = mcqFraction({ ...base, selected: [0], policy: "discordance" }).fraction;
    const extra = mcqFraction({ ...base, selected: [0, 1, 2], policy: "discordance" }).fraction;
    expect([missed, extra]).toEqual([0.5, 0.5]);
    // Three the wrong way round is worth nothing.
    expect(
      mcqFraction({ correct: [0, 1], choiceCount: 4, selected: [2, 3], policy: "discordance" })
        .fraction,
    ).toBe(0);
  });

  it("guards W = 0 in the symmetric policy", () => {
    const all = mcqFraction({
      correct: [0, 1],
      choiceCount: 2,
      selected: [0],
      policy: "symmetric",
    });
    expect([all.W, all.fraction]).toEqual([0, 0.5]);
  });

  it("cancels a ripkey answer on the first wrong tick", () => {
    expect(mcqFraction({ ...base, selected: [0, 1], policy: "ripkey" }).fraction).toBe(1);
    expect(mcqFraction({ ...base, selected: [0, 1, 2], policy: "ripkey" }).fraction).toBe(0);
  });

  it("stays total when a corrupted row has no correct choice", () => {
    const score = mcqFraction({ ...base, correct: [], selected: [0], policy: "symmetric" });
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

/**
 * Negative marking (ADR-026, #130): an evaluation-level rule that overrides
 * every policy, single and multiple answer alike.
 */
describe("mcqFraction with negative marking", () => {
  const neg = (correct: number[], choiceCount: number, selected: number[]) =>
    mcqFraction({ correct, choiceCount, selected, policy: "all_or_nothing", negativeMarking: true })
      .fraction;

  it("scores a single-answer question +1, -1/(n-1) or 0", () => {
    // Four choices, key 2: a distractor costs a third.
    expect(neg([2], 4, [2])).toBe(1);
    expect(neg([2], 4, [0])).toBeCloseTo(-1 / 3, 10);
    expect(neg([2], 4, [])).toBe(0);
    // Two choices (true / false): a wrong answer costs the whole point.
    expect(neg([0], 2, [1])).toBe(-1);
    // Five choices: a quarter.
    expect(neg([0], 5, [4])).toBe(-0.25);
  });

  it("scores a multiple-answer question c/C - w/W without the floor", () => {
    // C = 2, W = 2, the fixture of the truth table above.
    const table: [number[], number][] = [
      [[0, 1], 1],
      [[2, 3], -1],
      [[0], 0.5],
      [[0, 2], 0],
      [[2], -0.5],
      [[], 0],
      [[0, 1, 2, 3], 0],
    ];
    for (const [selected, expected] of table) {
      expect(neg([0, 1], 4, selected), String(selected)).toBeCloseTo(expected, 10);
    }
  });

  it("overrides every policy the question names", () => {
    for (const policy of Object.keys(EXPECTED) as McqScorePolicy[]) {
      const score = mcqFraction({ ...base, selected: [2, 3], policy, negativeMarking: true });
      expect(score.fraction, policy).toBe(-1);
    }
  });

  it("stays in [-1, 1] on every possible selection", () => {
    for (let n = 2; n <= 6; n++) {
      for (let keyMask = 1; keyMask < 1 << n; keyMask++) {
        const correct = indices(keyMask, n);
        for (let mask = 0; mask < 1 << n; mask++) {
          const f = neg(correct, n, indices(mask, n));
          expect(f).toBeGreaterThanOrEqual(-1);
          expect(f).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("gives a random single answer an expected value of 0", () => {
    for (let n = 2; n <= 8; n++) {
      let sum = 0;
      for (let pick = 0; pick < n; pick++) sum += neg([0], n, [pick]);
      expect(sum / n, `n = ${n}`).toBeCloseTo(0, 10);
    }
  });

  it("gives every random tick of a multiple-answer question an expected value of 0", () => {
    // Ticking each choice independently with probability 1/2 — every subset
    // equally likely — for every key of up to six choices with a distractor.
    for (let n = 2; n <= 6; n++) {
      for (let keyMask = 1; keyMask < (1 << n) - 1; keyMask++) {
        const correct = indices(keyMask, n);
        let sum = 0;
        for (let mask = 0; mask < 1 << n; mask++) sum += neg(correct, n, indices(mask, n));
        expect(sum / (1 << n), `n = ${n}, key ${correct}`).toBeCloseTo(0, 10);
      }
    }
  });

  it("scores no answer 0 and leaves the counters as they were", () => {
    const score = mcqFraction({ ...base, selected: [], policy: "symmetric", negativeMarking: true });
    expect(score).toEqual({ fraction: 0, c: 0, w: 0, C: 2, W: 2 });
  });

  it("is off unless asked for", () => {
    expect(mcqFraction({ ...base, selected: [2, 3], policy: "symmetric" }).fraction).toBe(0);
    expect(
      mcqFraction({ ...base, selected: [2, 3], policy: "symmetric", negativeMarking: false })
        .fraction,
    ).toBe(0);
  });

  it("stays total when a corrupted row has no correct choice", () => {
    expect(neg([], 4, [0])).toBe(0);
  });
});

/** The indices of the set bits of `mask`, below `n`. */
function indices(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
  return out;
}
