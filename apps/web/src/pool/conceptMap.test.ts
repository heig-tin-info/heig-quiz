import { describe, expect, it } from "vitest";

import type { PoolConceptMap } from "@quiz/contracts";

import { branches, levelCells, mapIndex, shownPath, validPath, type MapCell } from "./conceptMap";

/*
 * Memory (a grouping, no question of its own) › Pointer › Allocation › Leak,
 * Leak also under Heap (a poly-hierarchy), Pointer with one question of its
 * own, and Array, a top concept with no narrower one.
 */
const node = (id: string, covered: number, own: number) => ({
  concept: { id, label: id, qualifier: "", status: "validated" as const },
  covered,
  own,
});
const MAP: PoolConceptMap = {
  nodes: [
    node("Allocation", 3, 1),
    node("Array", 2, 2),
    node("Heap", 2, 0),
    node("Leak", 2, 2),
    node("Memory", 4, 0),
    node("Pointer", 4, 1),
  ],
  broader: [
    { concept: "Allocation", target: "Pointer" },
    { concept: "Leak", target: "Allocation" },
    { concept: "Leak", target: "Heap" },
    { concept: "Pointer", target: "Memory" },
  ],
};
const index = mapIndex(MAP);
/** A level as `kind:id=value`, the zoomable cells marked `›`. */
const draw = (cells: MapCell[]) =>
  cells.map((c) => `${c.kind === "itself" ? "itself" : c.node.concept.id}=${c.value}${c.kind === "concept" && c.zooms ? "›" : ""}`);

describe("the concept map's view model", () => {
  it("lists the top concepts at the root, an ancestor-only grouping included, and no itself cell", () => {
    expect(index.roots).toEqual(["Array", "Heap", "Memory"]);
    expect(draw(levelCells(index, null))).toEqual(["Array=2", "Heap=2›", "Memory=4›"]);
  });

  it("draws a concept with several broader ones under each, never twice in one level", () => {
    expect(draw(levelCells(index, "Allocation"))).toEqual(["Leak=2", "itself=1"]);
    expect(draw(levelCells(index, "Heap"))).toEqual(["Leak=2"]);
    const twice = mapIndex({ ...MAP, broader: [...MAP.broader, { concept: "Leak", target: "Allocation" }] });
    expect(twice.children("Allocation")).toEqual(["Leak"]);
  });

  it("adds the itself cell only when the concept has questions of its own", () => {
    expect(draw(levelCells(index, "Pointer"))).toEqual(["Allocation=3›", "itself=1"]);
    expect(draw(levelCells(index, "Memory"))).toEqual(["Pointer=4›"]);
  });

  it("shows a leaf at the end of the path as its itself cell alone", () => {
    expect(draw(levelCells(index, "Array"))).toEqual(["itself=2"]);
  });

  it("keeps the longest prefix of the address that is still a path", () => {
    expect(validPath(index, ["Memory", "Pointer", "Allocation"])).toEqual(["Memory", "Pointer", "Allocation"]);
    // Allocation is not a top concept, Leak is not under Pointer, Gone is not in the map.
    expect(validPath(index, ["Allocation"])).toEqual([]);
    expect(validPath(index, ["Memory", "Pointer", "Leak"])).toEqual(["Memory", "Pointer"]);
    expect(validPath(index, ["Heap", "Gone"])).toEqual(["Heap"]);
    // An edge removed since: Pointer is now a top concept, and Memory is gone with its last child.
    const cut = mapIndex({ nodes: MAP.nodes.filter((n) => n.concept.id !== "Memory"), broader: MAP.broader.slice(0, 3) });
    expect(validPath(cut, ["Memory", "Pointer"])).toEqual([]);
    expect(validPath(cut, ["Pointer", "Allocation"])).toEqual(["Pointer", "Allocation"]);
  });

  it("keeps a match's ancestors and subtree, and an itself cell only at or under a match", () => {
    expect(branches(index, "  ")).toBeNull();
    const kept = branches(index, "ALLOC")!;
    expect([...kept.concepts].sort()).toEqual(["Allocation", "Leak", "Memory", "Pointer"]);
    expect(draw(levelCells(index, null, kept))).toEqual(["Memory=4›"]);
    // Pointer is kept for the path only: no itself cell.
    expect(draw(levelCells(index, "Pointer", kept))).toEqual(["Allocation=3›"]);
    expect(draw(levelCells(index, "Allocation", kept))).toEqual(["Leak=2", "itself=1"]);
    // Heap holds a kept concept but is neither a match nor above one: never drawn, never reached.
    expect(shownPath(["Heap", "Leak"], kept)).toEqual([]);
  });

  it("cuts the drawn path where a search stops", () => {
    const kept = branches(index, "leak")!;
    expect(shownPath(["Memory", "Pointer"], kept)).toEqual(["Memory", "Pointer"]);
    expect(shownPath(["Memory", "Pointer"], branches(index, "array"))).toEqual([]);
    expect(shownPath(["Memory"], null)).toEqual(["Memory"]);
  });

  it("keeps nothing when nothing matches", () => {
    const kept = branches(index, "zzz")!;
    expect(kept.concepts.size).toBe(0);
    expect(levelCells(index, null, kept)).toEqual([]);
  });

  it("draws the old heat at the root of a pool with no hierarchy", () => {
    const flat = mapIndex({ nodes: MAP.nodes.filter((n) => n.own > 0), broader: [] });
    expect(draw(levelCells(flat, null))).toEqual(["Allocation=3", "Array=2", "Leak=2", "Pointer=4"]);
  });
});
