import { describe, expect, it } from "vitest";

import { applyOrder, moveFolder, neighbourMoves, subtreeIds } from "./categories";

/*
 * The moves of the categories page, as pure functions over the tree: what a
 * drag or an Alt+arrow sends to `PUT /pools/:id/categories/order`, and the
 * tree the page draws before the server has answered.
 */

interface N {
  id: string;
  parentId: string | null;
  position: number;
  children: N[];
}
const n = (id: string, parentId: string | null, position: number, children: N[] = []): N => ({
  id,
  parentId,
  position,
  children,
});

// a ─┬─ a1
//    └─ a2
// b
// c
const tree = (): N[] => [
  n("a", null, 0, [n("a1", "a", 0), n("a2", "a", 1)]),
  n("b", null, 1),
  n("c", null, 2),
];

const shape = (nodes: N[]): unknown[] =>
  nodes.map((x) => (x.children.length ? [x.id, shape(x.children)] : x.id));

describe("moveFolder", () => {
  it("reorders among siblings and renumbers the one list it touches", () => {
    expect(moveFolder(tree(), "c", { parentId: null, index: 0 })).toEqual([
      { id: "c", parentId: null, position: 0 },
      { id: "a", parentId: null, position: 1 },
      { id: "b", parentId: null, position: 2 },
    ]);
  });

  it("reparents, renumbering the list it joins AND the one it leaves", () => {
    expect(moveFolder(tree(), "a1", { parentId: "b", index: 0 })).toEqual([
      { id: "a1", parentId: "b", position: 0 },
      { id: "a2", parentId: "a", position: 0 },
    ]);
  });

  it("refuses a folder into itself or its own subtree, and a move to where it is", () => {
    expect(moveFolder(tree(), "a", { parentId: "a", index: 0 })).toBeNull();
    expect(moveFolder(tree(), "a", { parentId: "a1", index: 0 })).toBeNull();
    expect(moveFolder(tree(), "b", { parentId: null, index: 1 })).toBeNull();
    expect(moveFolder(tree(), "zz", { parentId: null, index: 0 })).toBeNull();
  });

  it("clamps an index past the end to the end", () => {
    expect(moveFolder(tree(), "a", { parentId: null, index: 99 })).toEqual([
      { id: "b", parentId: null, position: 0 },
      { id: "c", parentId: null, position: 1 },
      { id: "a", parentId: null, position: 2 },
    ]);
  });
});

describe("neighbourMoves", () => {
  it("offers what the position allows, and nothing else", () => {
    expect(neighbourMoves(tree(), "a")).toEqual({
      up: null,
      down: { parentId: null, index: 1 },
      indent: null,
      outdent: null,
    });
    expect(neighbourMoves(tree(), "b")).toEqual({
      up: { parentId: null, index: 0 },
      down: { parentId: null, index: 2 },
      // Into the folder above, after its last child.
      indent: { parentId: "a", index: 2 },
      outdent: null,
    });
    // Out of its parent, right after it.
    expect(neighbourMoves(tree(), "a2").outdent).toEqual({ parentId: null, index: 1 });
  });
});

describe("applyOrder", () => {
  it("draws the tree a move produces", () => {
    const items = moveFolder(tree(), "b", neighbourMoves(tree(), "b").indent!)!;
    expect(shape(applyOrder(tree(), items))).toEqual([["a", ["a1", "a2", "b"]], "c"]);
    const out = moveFolder(tree(), "a2", neighbourMoves(tree(), "a2").outdent!)!;
    expect(shape(applyOrder(tree(), out))).toEqual([["a", ["a1"]], "a2", "b", "c"]);
  });
});

describe("subtreeIds", () => {
  it("is the folder and everything under it", () => {
    expect([...subtreeIds(tree(), "a")].sort()).toEqual(["a", "a1", "a2"]);
    expect([...subtreeIds(tree(), "b")]).toEqual(["b"]);
  });
});
