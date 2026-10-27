import { describe, expect, it } from "vitest";

import { breakdownTotal, criteriaMaxima, scaleCriteria, validatedBreakdown } from "./essayCriteria.js";

describe("scaleCriteria", () => {
  it("keeps weight units when the item is worth the sum of the weights", () => {
    expect(
      scaleCriteria(
        [
          { weight: 2, earned: 1.5 },
          { weight: 1, earned: 1 },
        ],
        3,
      ),
    ).toEqual({
      criteria: [
        { points: 1.5, maxPoints: 2 },
        { points: 1, maxPoints: 1 },
      ],
      total: 2.5,
    });
  });

  it("scales to the item's points: two criteria of weight 1 on a 1-point item", () => {
    const scaled = scaleCriteria(
      [
        { weight: 1, earned: 1 },
        { weight: 1, earned: 0.5 },
      ],
      1,
    );
    expect(scaled.criteria).toEqual([
      { points: 0.5, maxPoints: 0.5 },
      { points: 0.25, maxPoints: 0.5 },
    ]);
    expect(scaled.total).toBe(0.75);
  });

  it("rescales a free rubric's breakdown, its maxima as the weights: 1 + 1 on a 1-point item", () => {
    expect(
      scaleCriteria(
        [
          { weight: 1, earned: 1 },
          { weight: 1, earned: 1 },
        ],
        1,
      ),
    ).toEqual({
      criteria: [
        { points: 0.5, maxPoints: 0.5 },
        { points: 0.5, maxPoints: 0.5 },
      ],
      total: 1,
    });
  });

  it("takes the total from the raw sum, never from the rounded parts", () => {
    const all = scaleCriteria([1, 1, 1].map((weight) => ({ weight, earned: 1 })), 2);
    expect(all.criteria.map((c) => c.points)).toEqual([0.67, 0.67, 0.67]);
    expect(all.criteria.map((c) => c.maxPoints)).toEqual([0.67, 0.67, 0.67]);
    expect(all.total).toBe(2);
    const two = scaleCriteria(
      [
        { weight: 1, earned: 1 },
        { weight: 1, earned: 1 },
        { weight: 1, earned: 0 },
      ],
      2,
    );
    expect(two.total).toBe(1.33);
  });

  it("clamps what the grader gave into [0, weight]", () => {
    const scaled = scaleCriteria(
      [
        { weight: 2, earned: 5 },
        { weight: 2, earned: -1 },
        { weight: 2, earned: Number.NaN },
      ],
      6,
    );
    expect(scaled.criteria.map((c) => c.points)).toEqual([2, 0, 0]);
    expect(scaled.total).toBe(2);
  });

  it("scales everything to 0 when the weights sum to 0", () => {
    expect(scaleCriteria([], 4)).toEqual({ criteria: [], total: 0 });
    expect(scaleCriteria([{ weight: 0, earned: 1 }], 4)).toEqual({
      criteria: [{ points: 0, maxPoints: 0 }],
      total: 0,
    });
  });
});

describe("validatedBreakdown (ADR-118, per-criterion grading)", () => {
  const declared = [
    { id: "a", title: "Argument", weight: 2 },
    { id: "b", title: "Sources", weight: 1 },
    { id: "c", title: "Style", weight: 1 },
  ];

  it("derives the total from the parts, in the declared order, titles from the declaration", () => {
    const result = validatedBreakdown(declared, 4, [
      { id: "c", points: 0.5 },
      { id: "a", points: 1.5 },
      { id: "b", points: 1 },
    ]);
    expect(result).toEqual({
      breakdown: [
        { id: "a", title: "Argument", points: 1.5, maxPoints: 2 },
        { id: "b", title: "Sources", points: 1, maxPoints: 1 },
        { id: "c", title: "Style", points: 0.5, maxPoints: 1 },
      ],
      total: 3,
    });
  });

  it("bounds each criterion by its scaled maximum, and rounds the total once", () => {
    const thirds = [
      { id: "x", title: "X", weight: 1 },
      { id: "y", title: "Y", weight: 1 },
      { id: "z", title: "Z", weight: 1 },
    ];
    expect(criteriaMaxima(thirds, 2)).toEqual([0.67, 0.67, 0.67]);
    const full = validatedBreakdown(thirds, 2, thirds.map((c) => ({ id: c.id, points: 0.67 })));
    // 2.01 clamped to the item's 2 points.
    expect(full?.total).toBe(2);
    const over = [
      { id: "x", points: 0.68 },
      { id: "y", points: 0 },
      { id: "z", points: 0 },
    ];
    expect(validatedBreakdown(thirds, 2, over)).toBeNull();
  });

  it("refuses anything that is not every criterion exactly once", () => {
    const ok = [
      { id: "a", points: 1 },
      { id: "b", points: 1 },
      { id: "c", points: 1 },
    ];
    const two = ok.slice(0, 2);
    expect(validatedBreakdown(declared, 4, ok)).not.toBeNull();
    // Missing, unknown, duplicate, negative, not a number.
    expect(validatedBreakdown(declared, 4, two)).toBeNull();
    expect(validatedBreakdown(declared, 4, [...two, { id: "z", points: 1 }])).toBeNull();
    expect(validatedBreakdown(declared, 4, [...two, { id: "a", points: 1 }])).toBeNull();
    expect(validatedBreakdown(declared, 4, [...two, { id: "c", points: -0.5 }])).toBeNull();
    expect(validatedBreakdown(declared, 4, [...two, { id: "c", points: Number.NaN }])).toBeNull();
    // No declared criteria: no breakdown at all.
    expect(validatedBreakdown([], 4, [])).toBeNull();
  });

  it("sums to the item's points at most", () => {
    expect(breakdownTotal([1.25, 2], 4)).toBe(3.25);
    expect(breakdownTotal([3, 3], 4)).toBe(4);
    expect(breakdownTotal([], 4)).toBe(0);
  });
});
