import { describe, expect, it } from "vitest";

import { compareMastery, drillMastery, type MasteryCard } from "./drillMastery.js";

const card = (id: string, userId: string, retrievability: number, ...conceptIds: string[]): MasteryCard => ({
  id,
  userId,
  retrievability,
  conceptIds,
});
const identity = (...ids: string[]) => new Map(ids.map((id) => [id, [id]]));

describe("drillMastery", () => {
  it("counts a card toward every listed concept that covers one of its own, once per line", () => {
    // `wide` covers `a` and `b`: a card of `b` counts for `wide` only, one of `a` for both.
    const coverage = new Map([
      ["wide", ["wide", "a", "b"]],
      ["a", ["a"]],
    ]);
    const out = drillMastery(
      [card("1", "u1", 0.5, "a", "b"), card("2", "u2", 0.9, "b"), card("3", "u1", 0.7, "a")],
      ["wide", "a"],
      coverage,
    );
    const byId = new Map(out.lines.map((l) => [l.conceptId, l]));
    expect(byId.get("wide")).toMatchObject({ cards: 3, students: 2 });
    expect(byId.get("wide")!.retrievability).toBeCloseTo(0.7);
    expect(byId.get("a")).toMatchObject({ cards: 2, students: 1 });
    expect(byId.get("a")!.retrievability).toBeCloseTo(0.6);
    expect(out.outside).toBeNull();
  });

  it("shows a listed concept nothing exercised as no evidence, after the others", () => {
    const out = drillMastery([card("1", "u", 0.4, "a")], ["idle", "a"], identity("idle", "a"));
    expect(out.lines).toEqual([
      { conceptId: "a", cards: 1, students: 1, retrievability: 0.4 },
      { conceptId: "idle", cards: 0, students: 0, retrievability: null },
    ]);
  });

  it("gathers what no listed concept covers outside, with and without a concept", () => {
    const out = drillMastery(
      [card("1", "u1", 0.7, "x"), card("2", "u2", 0.6), card("3", "u1", 0.2, "a"), card("4", "u2", 0.4, "x", "y")],
      ["a"],
      identity("a"),
    );
    expect(out.declared).toBe(true);
    expect(out.outside).toMatchObject({ cards: 3, students: 2 });
    expect(out.outside!.retrievability).toBeCloseTo(0.5666666667);
    // Weakest first: y (0.4), x (mean 0.55), the question without concept (0.6).
    expect(out.outside!.lines.map((l) => [l.conceptId, l.cards])).toEqual([
      ["y", 1],
      ["x", 2],
      [null, 1],
    ]);
  });

  it("is the flat view when the course lists nothing", () => {
    const out = drillMastery([card("1", "u", 0.9, "a"), card("2", "u", 0.3), card("3", "v", 0.5, "a", "b")], [], new Map());
    expect(out.declared).toBe(false);
    expect(out.outside).toBeNull();
    expect(out.lines.map((l) => [l.conceptId, l.cards])).toEqual([
      [null, 1],
      ["b", 1],
      ["a", 2],
    ]);
  });

  it("answers no line for no card and no list, a line without evidence for a list", () => {
    expect(drillMastery([], [], new Map())).toEqual({ declared: false, lines: [], outside: null });
    expect(drillMastery([], ["a"], identity("a")).lines).toEqual([
      { conceptId: "a", cards: 0, students: 0, retrievability: null },
    ]);
  });

  it("puts a card outside when its listed concept has no coverage entry", () => {
    const out = drillMastery([card("1", "u", 0.5, "a")], ["a"], new Map());
    expect(out.lines[0]).toMatchObject({ cards: 0 });
    expect(out.outside).toMatchObject({ cards: 1 });
  });
});

describe("compareMastery", () => {
  const line = (conceptId: string | null, retrievability: number | null) => ({
    conceptId,
    cards: 1,
    students: 1,
    retrievability,
  });

  it("orders weakest first, no evidence last, then by the tie rule, a missing concept last", () => {
    const rows = [line(null, 0.5), line("b", null), line("b", 0.5), line("a", null), line("a", 0.9), line("c", 0.1), line(null, null)];
    expect(rows.sort((x, y) => compareMastery(x, y)).map((l) => [l.conceptId, l.retrievability])).toEqual([
      ["c", 0.1],
      ["b", 0.5],
      [null, 0.5],
      ["a", 0.9],
      ["a", null],
      ["b", null],
      [null, null],
    ]);
  });

  it("takes the caller's tie rule", () => {
    const reversed = (a: string | null, b: string | null) => (a === b ? 0 : (a ?? "") < (b ?? "") ? 1 : -1);
    expect(compareMastery(line("a", 0.5), line("b", 0.5), reversed)).toBe(1);
    expect(compareMastery(line("a", 0.5), line("a", 0.5))).toBe(0);
    expect(compareMastery(line("a", 0.5), line("b", 0.5))).toBe(-1);
    expect(compareMastery(line("b", 0.5), line("a", 0.5))).toBe(1);
    expect(compareMastery(line("a", 0.5), line(null, 0.5))).toBe(-1);
  });
});
