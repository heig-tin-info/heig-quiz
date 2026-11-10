/**
 * Accepting a categorize answer at grading time (ADR-128): an accepted card
 * counts as right under every policy — a target at its place, a distractor
 * as if left out.
 */
import { describe, expect, it } from "vitest";

import { categorizeCounts, categorizeFraction } from "./categorizeScore.js";

const target = (right: boolean, placed = true) => ({ target: true, placed, right });
const distractor = (placed: boolean) => ({ target: false, placed, right: !placed });

describe("categorizeCounts", () => {
  it("counts the key's verdicts as before", () => {
    expect(categorizeCounts([target(true), target(false), target(false, false), distractor(true), distractor(false)])).toEqual({
      T: 3,
      D: 2,
      t: 1,
      x: 1,
      p: 1,
    });
  });

  it("counts an accepted target as right, never as misplaced", () => {
    expect(categorizeCounts([target(true), { ...target(false), accepted: true }])).toEqual({ T: 2, D: 0, t: 2, x: 0, p: 0 });
  });

  it("keeps an accepted placed distractor a distractor, no longer counted against the student", () => {
    expect(categorizeCounts([target(true), { ...distractor(true), accepted: true }, distractor(false)])).toEqual({
      T: 1,
      D: 2,
      t: 1,
      x: 0,
      p: 0,
    });
  });

  it("lifts all_or_nothing from 0 to full, and removes a penalty under negative marking", () => {
    const before = categorizeCounts([target(true), target(false)]);
    const after = categorizeCounts([target(true), { ...target(false), accepted: true }]);
    expect(categorizeFraction({ ...before, k: 3, policy: "all_or_nothing" })).toBe(0);
    expect(categorizeFraction({ ...after, k: 3, policy: "all_or_nothing" })).toBe(1);
    expect(categorizeFraction({ ...before, k: 3, policy: "per_item", negativeMarking: true })).toBe(0.25);
    expect(categorizeFraction({ ...after, k: 3, policy: "per_item", negativeMarking: true })).toBe(1);
  });

  it("never lets an accepted distractor beat the student who rightly left it out", () => {
    // Targets A and B, distractor Z, three columns: A right, B wrong.
    const leftOut = categorizeCounts([target(true), target(false), distractor(false)]);
    const accepted = categorizeCounts([target(true), target(false), { ...distractor(true), accepted: true }]);
    for (const policy of ["per_item", "all_or_nothing"] as const) {
      for (const negativeMarking of [false, true]) {
        const score = (counts: typeof leftOut) => categorizeFraction({ ...counts, k: 3, policy, negativeMarking });
        expect(score(accepted)).toBe(score(leftOut));
      }
    }
    expect(categorizeFraction({ ...accepted, k: 3, policy: "per_item", negativeMarking: true })).toBe(0.25);
  });
});
