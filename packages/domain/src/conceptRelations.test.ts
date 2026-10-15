import { describe, expect, it } from "vitest";

import {
  broaderAncestorsOf,
  broaderPath,
  canonicalRelated,
  checkBroaderEdge,
  checkRelatedEdge,
  coverageOf,
  edgesOf,
  mergedRelations,
  narrowerDescendants,
  narrowerDescendantsOf,
  relationsOf,
  unplaced,
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
  it("reaches every descendant, the concept itself excluded", () => {
    expect(narrowerDescendants(diamond.broader, "a")).toEqual(["b", "c", "d", "e"]);
    expect(narrowerDescendants(diamond.broader, "e")).toEqual([]);
    expect(narrowerDescendantsOf(diamond.broader, ["d", "e"])).toEqual(new Map([["d", ["e"]], ["e", []]]));
  });
  it("reaches every ancestor, the mirror of the descendants", () => {
    expect(broaderAncestorsOf(diamond.broader, ["e", "a"])).toEqual(new Map([["e", ["a", "b", "c", "d"]], ["a", []]]));
    const ids = ["a", "b", "c", "d", "e"];
    const up = broaderAncestorsOf(diamond.broader, ids);
    const down = narrowerDescendantsOf(diamond.broader, ids);
    for (const x of ids) for (const y of ids) expect(up.get(x)!.includes(y)).toBe(down.get(y)!.includes(x));
  });
  it("covers a concept and its narrower ones, itself first", () => {
    expect(coverageOf(diamond.broader, ["b", "e", "b"])).toEqual(new Map([["b", ["b", "d", "e"]], ["e", ["e"]]]));
    expect(coverageOf(diamond.broader, [])).toEqual(new Map());
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
    expect(narrowerDescendants(cyclic, "x")).toEqual(["y", "z"]);
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
    expect(out.dropped).toEqual({ broader: [], related: [], hierarchical: [] });
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
    expect(out.moved.related).toEqual([]);
    expect(out.after.broader).toHaveLength(3);
    expect(out.after.related).toEqual([canonicalRelated("W", "r")]);
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
  it("drops a related edge whose pair becomes a broader pair, rewritten or already stored", () => {
    // L related to x, W below x: after the merge W is related to x AND below it.
    const rewritten = mergedRelations({ broader: [b("W", "x")], related: [canonicalRelated("L", "x")] }, "L", "W");
    expect(rewritten.dropped.hierarchical).toEqual([canonicalRelated("W", "x")]);
    expect(rewritten.moved.related).toEqual([]);
    expect(rewritten.after.related).toEqual([]);
    // L below y, W related to y (stored): the stored related edge goes.
    const stored = mergedRelations({ broader: [b("L", "y")], related: [canonicalRelated("W", "y")] }, "L", "W");
    expect(stored.dropped.hierarchical).toEqual([canonicalRelated("W", "y")]);
    expect(stored.after).toEqual({ broader: [b("W", "y")], related: [] });
  });
  it("lists every edge of the loser, as it was", () => {
    const edges: RelationEdges = { broader: [b("L", "p"), b("c", "L"), b("m", "n")], related: [canonicalRelated("L", "r")] };
    expect(mergedRelations(edges, "L", "W").ofLoser).toEqual({ broader: [b("L", "p"), b("c", "L")], related: [canonicalRelated("L", "r")] });
  });
  it("leaves unrelated edges alone", () => {
    const out = mergedRelations(diamond, "x", "y");
    expect(out.moved).toEqual({ broader: [], related: [] });
    expect(out.cycle).toBeNull();
  });
});

describe("edgesOf and relationsOf", () => {
  const concepts = [
    { id: "a", broader: ["p"], related: ["b"] },
    { id: "b", broader: [], related: ["a"] },
    { id: "p", broader: [], related: [] },
  ];
  it("lists a related pair once, in canonical order, and a broader edge from its child", () => {
    expect(edgesOf(concepts)).toEqual({ broader: [b("a", "p")], related: [b("a", "b")] });
  });
  it("is inverted by relationsOf, a related pair on both sides, sorted", () => {
    const out = relationsOf(edgesOf(concepts));
    expect(out.get("a")).toEqual({ broader: ["p"], related: ["b"] });
    expect(out.get("b")).toEqual({ broader: [], related: ["a"] });
    expect(out.get("p")).toBeUndefined();
    expect(relationsOf({ broader: [b("c", "z"), b("c", "y")], related: [] }).get("c")?.broader).toEqual(["y", "z"]);
  });
});

describe("unplaced", () => {
  it("keeps the concepts with no broader and no narrower concept, a related one included", () => {
    const root = { id: "root", broader: [], related: [] };
    const child = { id: "child", broader: ["root"], related: [] };
    const lone = { id: "lone", broader: [], related: [] };
    const relatedOnly = { id: "rel", broader: [], related: ["lone"] };
    expect(unplaced([root, child, lone, relatedOnly])).toEqual([lone, relatedOnly]);
  });
});
