import { describe, expect, it } from "vitest";

import { rng, shuffle, shuffleWith, streamSeed } from "@quiz/core/rng";

import {
  itemSegments,
  opensSection,
  placeIntros,
  sectionedOrder,
  sectionSpans,
  textOnRemoval,
  type SectionItem,
} from "./sections.js";

const id = (item: SectionItem) => item.id;
const self = (item: SectionItem) => item;

const plain = (name: string): SectionItem => ({ id: name, intro: null, introScope: "item" });
const own = (name: string, text = `before ${name}`): SectionItem => ({ id: name, intro: text, introScope: "item" });
const head = (name: string, text = `section ${name}`): SectionItem => ({ id: name, intro: text, introScope: "following" });

const EVALUATION = "0b8f4c1e-1111-4a2a-9d55-000000000001";
const draw = (seed: number) => ({ shuffle: true, seed, evaluationId: EVALUATION });

describe("opensSection", () => {
  it("is a text applying to the following questions", () => {
    expect(opensSection(head("a"))).toBe(true);
    expect(opensSection(own("a"))).toBe(false);
    expect(opensSection({ intro: null, introScope: "following" })).toBe(false);
  });
});

describe("itemSegments", () => {
  it("has none for an empty list, and one leading run without a section", () => {
    expect(itemSegments([], self)).toEqual([]);
    const list = [plain("a"), own("b"), plain("c")];
    expect(itemSegments(list, self)).toEqual([{ head: null, items: list }]);
  });

  it("opens a section at each following text, up to the next one, a leading run before", () => {
    const list = [plain("a"), head("b"), plain("c"), own("d"), head("e"), plain("f")];
    expect(itemSegments(list, self).map((s) => [s.head?.id ?? null, s.items.map(id)])).toEqual([
      [null, ["a"]],
      ["b", ["b", "c", "d"]],
      ["e", ["e", "f"]],
    ]);
  });

  it("has no leading run when the first item opens a section", () => {
    expect(itemSegments([head("a"), plain("b")], self).map((s) => s.head?.id)).toEqual(["a"]);
  });
});

describe("sectionedOrder", () => {
  const many = Array.from({ length: 12 }, (_, i) => (i % 4 === 1 ? own(`q${i}`) : plain(`q${i}`)));

  it("keeps the canonical order without shuffle", () => {
    const list = [plain("a"), head("b"), plain("c")];
    expect(sectionedOrder(list, self, { ...draw(7), shuffle: false })).toEqual(list);
  });

  it("is exactly the order drawn before sections when no text opens one (golden)", () => {
    for (const seed of [0, 1, 42, 987_654_321]) {
      const before = shuffle(many, streamSeed(seed, EVALUATION, "items"));
      expect(sectionedOrder(many, self, draw(seed))).toEqual(before);
    }
    // Pinned: the permutation `shuffle` drew for seed 42 before sections, never to move.
    expect(sectionedOrder(many, self, draw(42)).map(id)).toEqual([
      "q4", "q11", "q2", "q1", "q7", "q9", "q0", "q8", "q6", "q3", "q5", "q10",
    ]);
  });

  it("shuffles inside each segment and keeps the segments in their order", () => {
    const list = [plain("a0"), plain("a1"), plain("a2"), head("b0"), plain("b1"), own("b2"), head("c0"), plain("c1")];
    for (let seed = 0; seed < 30; seed++) {
      const order = sectionedOrder(list, self, draw(seed)).map(id);
      expect(order.slice(0, 3).sort()).toEqual(["a0", "a1", "a2"]);
      expect(order.slice(3, 6).sort()).toEqual(["b0", "b1", "b2"]);
      expect(order.slice(6).sort()).toEqual(["c0", "c1"]);
    }
  });

  it("draws every segment from one stream, consumed segment after segment", () => {
    const list = [plain("a0"), plain("a1"), plain("a2"), head("b0"), plain("b1"), plain("b2"), plain("b3")];
    const next = rng(streamSeed(5, EVALUATION, "items"));
    const expected = [...shuffleWith(list.slice(0, 3), next), ...shuffleWith(list.slice(3), next)];
    expect(sectionedOrder(list, self, draw(5))).toEqual(expected);
  });
});

describe("placeIntros", () => {
  it("leaves item texts on their items and a section's text on its head without shuffle", () => {
    const list = [own("a"), head("b"), own("c"), plain("d")];
    expect(placeIntros(list, list, self)).toEqual([
      { intro: "before a", sectionIntro: null, section: null },
      { intro: null, sectionIntro: "section b", section: "b" },
      { intro: "before c", sectionIntro: null, section: "b" },
      { intro: null, sectionIntro: null, section: "b" },
    ]);
  });

  it("moves a section's text to the first of its items in the student's order", () => {
    const list = [plain("a"), head("b"), plain("c"), plain("d")];
    const ordered = [list[0]!, list[3]!, list[1]!, list[2]!];
    expect(placeIntros(list, ordered, self)).toEqual([
      { intro: null, sectionIntro: null, section: null },
      { intro: null, sectionIntro: "section b", section: "b" },
      { intro: null, sectionIntro: null, section: "b" },
      { intro: null, sectionIntro: null, section: "b" },
    ]);
  });

  it("keeps the two texts apart when the first item drawn has its own", () => {
    const list = [head("a"), own("b"), plain("c")];
    expect(placeIntros(list, [list[1]!, list[2]!, list[0]!], self)).toEqual([
      { intro: "before b", sectionIntro: "section a", section: "a" },
      { intro: null, sectionIntro: null, section: "a" },
      { intro: null, sectionIntro: null, section: "a" },
    ]);
  });
});

describe("textOnRemoval", () => {
  it("moves a section's text to the next item of the section when it has none", () => {
    expect(textOnRemoval([head("a"), plain("b")], "a", self)).toEqual({ moveTo: "b", dropped: false });
  });

  it("drops it when the next item has a text, opens another section, or there is none", () => {
    expect(textOnRemoval([head("a"), own("b")], "a", self)).toEqual({ moveTo: null, dropped: true });
    expect(textOnRemoval([head("a"), head("b")], "a", self)).toEqual({ moveTo: null, dropped: true });
    expect(textOnRemoval([plain("z"), head("a")], "a", self)).toEqual({ moveTo: null, dropped: true });
  });

  it("drops an item's own text with it, and has nothing to do for an item without one", () => {
    expect(textOnRemoval([own("a"), plain("b")], "a", self)).toEqual({ moveTo: null, dropped: true });
    expect(textOnRemoval([plain("a"), plain("b")], "a", self)).toEqual({ moveTo: null, dropped: false });
    expect(textOnRemoval([plain("a")], "missing", self)).toEqual({ moveTo: null, dropped: false });
  });
});

describe("sectionSpans", () => {
  it("lists each section's items, its head first, and nothing for the leading run", () => {
    const list = [plain("a"), head("b"), own("c"), head("d")];
    expect([...sectionSpans(list, self)]).toEqual([
      ["b", ["b", "c"]],
      ["d", ["d"]],
    ]);
  });
});
