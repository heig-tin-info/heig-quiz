/**
 * Accepting a categorize answer at grading time (ADR-128): an accepted card
 * counts as a right target under every policy.
 */
import { describe, expect, it } from "vitest";

import {
  categorizeCounts,
  categorizeFraction,
  categorizeIdentityPlace,
  categorizePlaceIdentity,
} from "./categorizeScore.js";

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

  it("turns an accepted placed distractor into a right target", () => {
    expect(categorizeCounts([target(true), { ...distractor(true), accepted: true }, distractor(false)])).toEqual({
      T: 2,
      D: 1,
      t: 2,
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
});

describe("the identity of a place", () => {
  it("is the column, or the column and the rank when the order counts", () => {
    expect(categorizePlaceIdentity({ column: "c1", rank: 2 }, false)).toBe("c1");
    expect(categorizePlaceIdentity({ column: "c1", rank: 2 }, true)).toBe("c1#2");
  });

  it("reads back, refusing a shape of the other mode", () => {
    expect(categorizeIdentityPlace("c1", false)).toEqual({ column: "c1", rank: null });
    expect(categorizeIdentityPlace("c1#2", true)).toEqual({ column: "c1", rank: 2 });
    expect(categorizeIdentityPlace("c1#2", false)).toBeNull();
    expect(categorizeIdentityPlace("c1", true)).toBeNull();
    expect(categorizeIdentityPlace("c1#0", true)).toBeNull();
  });
});
