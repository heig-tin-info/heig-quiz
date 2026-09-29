import { describe, expect, it } from "vitest";

import { composeDrillSession, DRILL_UNKNOWN_REFERENCE_MS, type DrillCandidate } from "./drillSession.js";

const now = new Date("2026-10-10T08:00:00Z");
const day = (d: number) => new Date(now.getTime() + d * 86_400_000);
const card = (id: string, over: Partial<DrillCandidate> = {}): DrillCandidate => ({
  id,
  isNew: false,
  dueAt: day(-1),
  retrievability: 0.8,
  referenceMs: 60_000,
  group: "A",
  ...over,
});
const compose = (cards: DrillCandidate[], budgetMs = 600_000, newAllowed = 10) =>
  composeDrillSession({ cards, now, budgetMs, newAllowed });

describe("composeDrillSession", () => {
  it("returns an empty session when nothing is due and nothing is new", () => {
    expect(compose([])).toEqual([]);
    expect(compose([card("later", { dueAt: day(2) })])).toEqual([]);
  });

  it("puts due cards first, the lowest retrievability ahead, then the oldest due, then the id", () => {
    const cards = [
      card("r9", { retrievability: 0.9 }),
      card("r5", { retrievability: 0.5 }),
      card("r7-late", { retrievability: 0.7, dueAt: day(0) }),
      card("r7-b", { retrievability: 0.7, dueAt: day(-3) }),
      card("r7-a", { retrievability: 0.7, dueAt: day(-3) }),
      card("new", { isNew: true, retrievability: 0, dueAt: day(-9) }),
    ];
    expect(compose(cards)).toEqual(["r5", "r7-a", "r7-b", "r7-late", "r9", "new"]);
  });

  it("caps the new cards at what today still allows, oldest first", () => {
    const fresh = [3, 1, 2].map((d) => card(`n${d}`, { isNew: true, dueAt: day(-d) }));
    expect(compose(fresh, 600_000, 2)).toEqual(["n3", "n2"]);
    expect(compose(fresh, 600_000, 0)).toEqual([]);
    expect(compose(fresh, 600_000, -1)).toEqual([]);
  });

  it("stops at the first card that would overrun the budget", () => {
    const cards = [
      card("a", { retrievability: 0.1, referenceMs: 300_000 }),
      card("b", { retrievability: 0.2, referenceMs: 200_000 }),
      card("c", { retrievability: 0.3, referenceMs: 200_000 }),
      card("d", { retrievability: 0.4, referenceMs: 10_000 }),
    ];
    expect(compose(cards)).toEqual(["a", "b"]);
    expect(compose(cards, 500_000)).toEqual(["a", "b"]);
    expect(compose(cards, 499_999)).toEqual(["a"]);
  });

  it("when every card is due, takes what fits the budget", () => {
    const all = Array.from({ length: 30 }, (_, i) => card(`c${String(i).padStart(2, "0")}`, { retrievability: i / 100 }));
    expect(compose(all)).toEqual(all.slice(0, 10).map((c) => c.id));
  });

  it("never comes back empty when a card is available, even with a budget smaller than one card", () => {
    expect(compose([card("long", { referenceMs: 900_000 }), card("x", { retrievability: 0.9 })], 60_000)).toEqual([
      "long",
    ]);
    expect(compose([card("n", { isNew: true })], 0)).toEqual(["n"]);
  });

  it("counts a card without a reference time as the declared fallback", () => {
    const cards = [card("a", { retrievability: 0.1, referenceMs: null }), card("b", { retrievability: 0.2, referenceMs: null })];
    expect(compose(cards, 2 * DRILL_UNKNOWN_REFERENCE_MS)).toEqual(["a", "b"]);
    expect(compose(cards, 2 * DRILL_UNKNOWN_REFERENCE_MS - 1)).toEqual(["a"]);
  });

  it("interleaves the groups within the due block and within the new block", () => {
    const cards = [
      card("a1", { retrievability: 0.1, group: "A" }),
      card("a2", { retrievability: 0.2, group: "A" }),
      card("a3", { retrievability: 0.3, group: "A" }),
      card("b1", { retrievability: 0.4, group: "B" }),
      card("c1", { retrievability: 0.5, group: "C" }),
      card("nb", { isNew: true, dueAt: day(-2), group: "B" }),
      card("nb2", { isNew: true, dueAt: day(-1), group: "B" }),
      card("na", { isNew: true, dueAt: day(0), group: "A" }),
    ];
    expect(compose(cards)).toEqual(["a1", "b1", "c1", "a2", "a3", "nb", "na", "nb2"]);
    // round-robin in the order the groups first appear, each keeping its own order
    const mixed = ["x1", "y1", "x2", "x3", "z1", "y2"].map((id, i) => card(id, { retrievability: i / 10, group: id[0]! }));
    expect(compose(mixed)).toEqual(["x1", "y1", "z1", "x2", "y2", "x3"]);
  });
});
