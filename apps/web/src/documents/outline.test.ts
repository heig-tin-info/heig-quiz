import { describe, expect, it } from "vitest";

import { currentEntry, markdownOutline, outlineTree } from "./outline";

const toc = (...entries: [number, string][]) => entries.map(([depth, text], i) => ({ id: `h${i}`, depth, text }));

describe("the outline of a Markdown document", () => {
  it("leaves the lone title out and keeps two levels under it", () => {
    const { items, ids } = markdownOutline(toc([1, "Title"], [2, "Basics"], [3, "Follower"], [4, "Deep"], [2, "Limits"]));
    expect(items).toEqual([
      { title: "Basics", level: 1 },
      { title: "Follower", level: 2 },
      { title: "Limits", level: 1 },
    ]);
    expect(ids).toEqual(["h1", "h2", "h4"]);
  });

  it("keeps several h1 (they are sections, not a title), and a lone heading", () => {
    expect(markdownOutline(toc([1, "A"], [2, "a"], [1, "B"])).items.map((i) => i.level)).toEqual([1, 2, 1]);
    expect(markdownOutline(toc([1, "Only"])).items).toEqual([{ title: "Only", level: 1 }]);
  });

  it("starts at the shallowest level present, and skips empty headings", () => {
    expect(markdownOutline(toc([3, "x"], [4, "y"], [3, "  "])).items).toEqual([
      { title: "x", level: 1 },
      { title: "y", level: 2 },
    ]);
    expect(markdownOutline([]).items).toEqual([]);
  });
});

describe("the outline as a tree", () => {
  it("hangs a second level under the entry before it, or at the top when there is none", () => {
    const tree = outlineTree([
      { title: "orphan", level: 2 },
      { title: "A", level: 1 },
      { title: "a1", level: 2 },
      { title: "a2", level: 2 },
      { title: "B", level: 1 },
    ]);
    expect(tree.map((n) => [n.item.title, n.index, n.children.map((c) => c.index)])).toEqual([
      ["orphan", 0, []],
      ["A", 1, [2, 3]],
      ["B", 4, []],
    ]);
  });
});

describe("the entry being read", () => {
  it("is the last one starting at or before the position", () => {
    expect(currentEntry([1, 1, 4, null, 9], 1)).toBe(1);
    expect(currentEntry([1, 1, 4, null, 9], 8)).toBe(2);
    expect(currentEntry([1, 1, 4, null, 9], 12)).toBe(4);
    expect(currentEntry([3, 4], 2)).toBe(-1);
  });
});
