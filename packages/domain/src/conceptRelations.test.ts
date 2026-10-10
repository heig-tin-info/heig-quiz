import { describe, expect, it } from "vitest";

import {
  broaderAncestors,
  broaderPath,
  canonicalRelated,
  checkBroaderEdge,
  checkRelatedEdge,
  mergedRelations,
  narrowerDescendants,
  type RelationEdge,
  type RelationEdges,
} from "./conceptRelations.js";

const b = (concept: string, target: string): RelationEdge => ({ concept, target });
const none: RelationEdges = { broader: [], related: [] };

// d -> b -> a and d -> c -> a (two parents), e -> d
const diamond: RelationEdges = {
  broader: [b("d", "b"), b("d", "c"), b("b", "a"), b("c", "a"), b("e", "d")],
  related: [],
};

describe("broader closure", () => {
  it("reaches every ancestor through several parents, once", () => {
    expect(broaderAncestors(diamond.broader, "e")).toEqual(["a", "b", "c", "d"]);
    expect(broaderAncestors(diamond.broader, "a")).toEqual([]);
  });
  it("reaches every descendant, the concept itself excluded", () => {
    expect(narrowerDescendants(diamond.broader, "a")).toEqual(["b", "c", "d", "e"]);
    expect(narrowerDescendants(diamond.broader, "e")).toEqual([]);
  });
  it("finds the shortest path up, or null", () => {
    const path = broaderPath(diamond.broader, "e", "a")!;
    expect(path).toHaveLength(4);
    expect(path[0]).toBe("e");
    expect(path[3]).toBe("a");
    expect(broaderPath(diamond.broader, "a", "e")).toBeNull();
  });
  it("finds the cycle through a concept, and survives a cyclic input", () => {
    const cyclic = [b("x", "y"), b("y", "z"), b("z", "x")];
    expect(broaderPath(cyclic, "x", "x")).toEqual(["x", "y", "z", "x"]);
    expect(broaderAncestors(cyclic, "x")).toEqual(["y", "z"]);
    expect(broaderPath([b("x", "x")], "x", "x")).toEqual(["x", "x"]);
    expect(broaderPath(diamond.broader, "e", "e")).toBeNull();
  });
});

describe("checkBroaderEdge", () => {
  it("accepts a new parent, including a second one", () => {
    expect(checkBroaderEdge(diamond, "e", "a")).toBeNull();
    expect(checkBroaderEdge(none, "a", "b")).toBeNull();
  });
  it("refuses itself and an existing edge", () => {
    expect(checkBroaderEdge(diamond, "a", "a")).toEqual({ kind: "self" });
    expect(checkBroaderEdge(diamond, "d", "b")).toEqual({ kind: "exists" });
  });
  it("refuses the opposite edge, naming the closed path", () => {
    expect(checkBroaderEdge({ broader: [b("a", "b")], related: [] }, "b", "a")).toEqual({
      kind: "cycle",
      path: ["b", "a", "b"],
    });
  });
  it("refuses a long cycle with the shortest path", () => {
    const refusal = checkBroaderEdge(diamond, "a", "e");
    expect(refusal).toMatchObject({ kind: "cycle" });
    const path = (refusal as { path: string[] }).path;
    expect(path).toHaveLength(5);
    expect(path.slice(0, 3)).toEqual(["a", "e", "d"]);
    expect(path[4]).toBe("a");
  });
  it("refuses a pair already related, in either order", () => {
    const related = { broader: [], related: [canonicalRelated("a", "b")] };
    expect(checkBroaderEdge(related, "a", "b")).toEqual({ kind: "redundant" });
    expect(checkBroaderEdge(related, "b", "a")).toEqual({ kind: "redundant" });
  });
});

describe("checkRelatedEdge", () => {
  it("accepts two unconnected concepts, even in different branches", () => {
    expect(checkRelatedEdge(diamond, "b", "c")).toBeNull();
  });
  it("refuses itself and an existing edge in either order", () => {
    const edges = { broader: [], related: [canonicalRelated("q", "p")] };
    expect(checkRelatedEdge(edges, "p", "p")).toEqual({ kind: "self" });
    expect(checkRelatedEdge(edges, "p", "q")).toEqual({ kind: "exists" });
    expect(checkRelatedEdge(edges, "q", "p")).toEqual({ kind: "exists" });
  });
  it("refuses two concepts of one broader chain, near or far, in either order", () => {
    expect(checkRelatedEdge(diamond, "d", "b")).toEqual({ kind: "redundant" });
    expect(checkRelatedEdge(diamond, "a", "e")).toEqual({ kind: "redundant" });
    expect(checkRelatedEdge(diamond, "e", "a")).toEqual({ kind: "redundant" });
  });
});

describe("canonicalRelated", () => {
  it("puts the smaller id first", () => {
    expect(canonicalRelated("b", "a")).toEqual(b("a", "b"));
    expect(canonicalRelated("a", "b")).toEqual(b("a", "b"));
  });
});

describe("mergedRelations", () => {
  it("rewrites the loser's edges onto the winner, both directions", () => {
    const edges: RelationEdges = { broader: [b("L", "p"), b("c", "L")], related: [canonicalRelated("L", "r")] };
    const out = mergedRelations(edges, "L", "W");
    expect(out.moved.broader).toEqual([b("W", "p"), b("c", "W")]);
    expect(out.moved.related).toEqual([canonicalRelated("W", "r")]);
    expect(out.dropped).toEqual({ broader: [], related: [] });
    expect(out.cycle).toBeNull();
  });
  it("drops the edges between the loser and the winner, whatever their orientation or kind", () => {
    const edges: RelationEdges = {
      broader: [b("L", "W"), b("W", "L")],
      related: [canonicalRelated("W", "L")],
    };
    const out = mergedRelations(edges, "L", "W");
    expect(out.dropped.broader).toHaveLength(2);
    expect(out.dropped.related).toEqual([canonicalRelated("L", "W")]);
    expect(out.moved).toEqual({ broader: [], related: [] });
    expect(out.cycle).toBeNull();
  });
  it("does not write twice an edge the winner has, or two the rewrite makes equal", () => {
    const edges: RelationEdges = {
      broader: [b("L", "p"), b("W", "p"), b("L", "q"), b("W", "q"), b("L", "s")],
      related: [canonicalRelated("L", "r"), canonicalRelated("W", "r")],
    };
    const out = mergedRelations(edges, "L", "W");
    expect(out.moved.broader).toEqual([b("W", "s")]);
    expect(out.duplicates.broader).toEqual([b("W", "p"), b("W", "q")]);
    expect(out.moved.related).toEqual([]);
    expect(out.duplicates.related).toEqual([canonicalRelated("W", "r")]);
    const twice = mergedRelations({ broader: [b("L", "t"), b("t", "L")], related: [] }, "L", "W");
    expect(twice.moved.broader).toEqual([b("W", "t"), b("t", "W")]);
  });
  it("detects a longer cycle and names its path", () => {
    // L is below x, x is below W: merging L into W makes W below x below W.
    const edges: RelationEdges = { broader: [b("L", "x"), b("x", "W")], related: [] };
    expect(mergedRelations(edges, "L", "W").cycle).toEqual(["W", "x", "W"]);
    const longer: RelationEdges = { broader: [b("W", "m"), b("m", "n"), b("n", "L")], related: [] };
    expect(mergedRelations(longer, "L", "W").cycle).toEqual(["W", "m", "n", "W"]);
  });
  it("leaves unrelated edges alone", () => {
    const out = mergedRelations(diamond, "x", "y");
    expect(out.moved).toEqual({ broader: [], related: [] });
    expect(out.cycle).toBeNull();
  });
});
