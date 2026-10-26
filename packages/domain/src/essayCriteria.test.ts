import { describe, expect, it } from "vitest";

import { scaleCriteria } from "./essayCriteria.js";

describe("scaleCriteria", () => {
  it("keeps weight units when the item is worth the sum of the weights", () => {
    const scaled = scaleCriteria(
      [
        { id: "a", weight: 2, earned: 1.5 },
        { id: "b", weight: 1, earned: 1 },
      ],
      3,
    );
    expect(scaled).toEqual({
      criteria: [
        { id: "a", points: 1.5, maxPoints: 2 },
        { id: "b", points: 1, maxPoints: 1 },
      ],
      total: 2.5,
    });
  });

  it("scales to the item's points: two criteria of weight 1 on a 1-point item", () => {
    const scaled = scaleCriteria(
      [
        { id: "a", weight: 1, earned: 1 },
        { id: "b", weight: 1, earned: 0.5 },
      ],
      1,
    );
    expect(scaled.criteria).toEqual([
      { id: "a", points: 0.5, maxPoints: 0.5 },
      { id: "b", points: 0.25, maxPoints: 0.5 },
    ]);
    expect(scaled.total).toBe(0.75);
  });

  it("takes the total from the raw sum, never from the rounded parts", () => {
    const all = scaleCriteria(
      ["a", "b", "c"].map((id) => ({ id, weight: 1, earned: 1 })),
      2,
    );
    expect(all.criteria.map((c) => c.points)).toEqual([0.67, 0.67, 0.67]);
    expect(all.criteria.map((c) => c.maxPoints)).toEqual([0.67, 0.67, 0.67]);
    expect(all.total).toBe(2);
    const two = scaleCriteria(
      [
        { id: "a", weight: 1, earned: 1 },
        { id: "b", weight: 1, earned: 1 },
        { id: "c", weight: 1, earned: 0 },
      ],
      2,
    );
    expect(two.total).toBe(1.33);
  });

  it("clamps what the grader gave into [0, weight]", () => {
    const scaled = scaleCriteria(
      [
        { id: "a", weight: 2, earned: 5 },
        { id: "b", weight: 2, earned: -1 },
        { id: "c", weight: 2, earned: Number.NaN },
      ],
      6,
    );
    expect(scaled.criteria.map((c) => c.points)).toEqual([2, 0, 0]);
    expect(scaled.total).toBe(2);
  });

  it("scales everything to 0 when the weights sum to 0", () => {
    expect(scaleCriteria([], 4)).toEqual({ criteria: [], total: 0 });
    expect(scaleCriteria([{ id: "a", weight: 0, earned: 1 }], 4)).toEqual({
      criteria: [{ id: "a", points: 0, maxPoints: 0 }],
      total: 0,
    });
  });
});
