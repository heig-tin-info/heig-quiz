import { describe, expect, it } from "vitest";

import { squarify, type TreemapCell } from "./treemap";

const byValue = (n: number) => n;
const EPS = 1e-6;

function overlap(a: TreemapCell<unknown>, b: TreemapCell<unknown>): boolean {
  return (
    a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS && a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS
  );
}

describe("squarify", () => {
  it("answers no cell for no item, a zero total or an empty box", () => {
    expect(squarify([], byValue, 100, 100)).toEqual([]);
    expect(squarify([0, 0], byValue, 100, 100)).toEqual([]);
    expect(squarify([3], byValue, 0, 100)).toEqual([]);
  });

  it("gives a single item the whole box", () => {
    const [cell, ...rest] = squarify([7], byValue, 300, 200);
    expect(rest).toEqual([]);
    expect(cell).toMatchObject({ item: 7, x: 0, y: 0 });
    expect(cell!.w).toBeCloseTo(300, 9);
    expect(cell!.h).toBeCloseTo(200, 9);
  });

  it("drops items of value zero", () => {
    const cells = squarify([4, 0, 2], byValue, 60, 60);
    expect(cells.map((c) => c.item)).toEqual([4, 2]);
  });

  it("makes each area proportional to its share, inside the box, without overlap", () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const width = 600;
    const height = 400;
    const cells = squarify(values, byValue, width, height);
    const total = values.reduce((s, v) => s + v, 0);
    expect(cells).toHaveLength(values.length);
    for (const c of cells) {
      expect(c.w * c.h).toBeCloseTo((c.item / total) * width * height, 6);
      expect(c.x).toBeGreaterThanOrEqual(-EPS);
      expect(c.y).toBeGreaterThanOrEqual(-EPS);
      expect(c.x + c.w).toBeLessThanOrEqual(width + EPS);
      expect(c.y + c.h).toBeLessThanOrEqual(height + EPS);
    }
    for (const [i, a] of cells.entries()) {
      for (const b of cells.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    }
    // The cells tile the box.
    expect(cells.reduce((s, c) => s + c.w * c.h, 0)).toBeCloseTo(width * height, 6);
  });

  it("orders the cells by decreasing value, ties in input order", () => {
    const items = [
      { id: "a", n: 1 },
      { id: "b", n: 5 },
      { id: "c", n: 1 },
    ];
    expect(squarify(items, (i) => i.n, 100, 100).map((c) => c.item.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps the cells of equal items square in a square box", () => {
    const cells = squarify([1, 1, 1, 1], byValue, 100, 100);
    for (const c of cells) {
      expect(c.w).toBeCloseTo(50, 6);
      expect(c.h).toBeCloseTo(50, 6);
    }
  });
});
