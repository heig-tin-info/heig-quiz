import { describe, expect, it } from "vitest";

import {
  DRILL_LEVEL_GETTING_FROM,
  DRILL_LEVEL_MIN_CARDS,
  DRILL_LEVEL_SOLID_FROM,
  drillLevel,
  studentConceptLevels,
} from "./drillLevel.js";
import type { MasteryCard } from "./drillMastery.js";

const cards = (n: number, retrievability: number, ...conceptIds: string[]): MasteryCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${conceptIds.join("")}${i}`, userId: "u", retrievability, conceptIds }));
const self = (...ids: string[]) => new Map(ids.map((id) => [id, [id]]));

describe("drillLevel", () => {
  it("cuts the mean retrievability at 0.7 and 0.9, the edges going up", () => {
    expect(DRILL_LEVEL_GETTING_FROM).toBe(0.7);
    expect(DRILL_LEVEL_SOLID_FROM).toBe(0.9);
    expect(drillLevel(0)).toBe("work");
    expect(drillLevel(0.699)).toBe("work");
    expect(drillLevel(0.7)).toBe("getting");
    expect(drillLevel(0.899)).toBe("getting");
    expect(drillLevel(0.9)).toBe("solid");
    expect(drillLevel(1)).toBe("solid");
  });

  it("shares the calibration's threshold of 5", () => {
    expect(DRILL_LEVEL_MIN_CARDS).toBe(5);
  });
});

describe("studentConceptLevels", () => {
  it("gives a level from 5 cards only, else no data, with the count", () => {
    const out = studentConceptLevels(
      [...cards(5, 0.95, "a"), ...cards(4, 0.1, "b")],
      [
        { id: "a", validated: true },
        { id: "b", validated: true },
        { id: "idle", validated: true },
      ],
      self("a", "b", "idle"),
    );
    expect(out).toEqual([
      { conceptId: "a", cards: 5, level: "solid" },
      { conceptId: "b", cards: 4, level: null },
      { conceptId: "idle", cards: 0, level: null },
    ]);
  });

  it("keeps the order of the list, not the level, and drops a proposed concept", () => {
    const out = studentConceptLevels(
      [...cards(5, 0.2, "a"), ...cards(5, 0.8, "b"), ...cards(5, 0.1, "p")],
      [
        { id: "b", validated: true },
        { id: "p", validated: false },
        { id: "a", validated: true },
      ],
      self("a", "b", "p"),
    );
    expect(out.map((l) => [l.conceptId, l.level])).toEqual([
      ["b", "getting"],
      ["a", "work"],
    ]);
  });

  it("rolls a card up through coverage and counts nothing outside the list", () => {
    const out = studentConceptLevels(
      [...cards(5, 0.95, "narrow"), ...cards(3, 0.1, "elsewhere")],
      [{ id: "wide", validated: true }],
      new Map([["wide", ["wide", "narrow"]]]),
    );
    expect(out).toEqual([{ conceptId: "wide", cards: 5, level: "solid" }]);
  });

  it("is empty when the course lists nothing", () => {
    expect(studentConceptLevels(cards(9, 0.5, "a"), [], new Map())).toEqual([]);
  });
});
