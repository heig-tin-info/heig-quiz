import { describe, expect, it } from "vitest";

import { conceptMap, type ConceptLink, type ConceptMapNode } from "./conceptMap.js";
import type { RelationEdge } from "./conceptRelations.js";

const b = (concept: string, target: string): RelationEdge => ({ concept, target });
const link = (question: string, ...concepts: string[]): ConceptLink[] => concepts.map((concept) => ({ question, concept }));
const byId = (nodes: ConceptMapNode[]) => Object.fromEntries(nodes.map(({ id, ...rest }) => [id, rest]));

// root <- mid <- leaf (a chain); root <- other; side under both leaf and other.
const graph = [b("mid", "root"), b("leaf", "mid"), b("other", "root"), b("side", "leaf"), b("side", "other")];

describe("conceptMap", () => {
  it("counts a chain: each concept covers its narrower ones, own counts what none of them has", () => {
    const map = conceptMap([...link("q1", "leaf"), ...link("q2", "mid"), ...link("q3", "root")], graph);
    expect(byId(map.nodes)).toEqual({
      root: { covered: 3, own: 1, linked: true },
      mid: { covered: 2, own: 1, linked: true },
      leaf: { covered: 1, own: 1, linked: true },
    });
    expect(map.nodes.map((n) => n.id)).toEqual(["leaf", "mid", "root"]);
    expect(map.broader).toEqual([b("leaf", "mid"), b("mid", "root")]);
  });

  it("counts a concept under two broader ones in both branches, and once at their common root", () => {
    const map = byId(conceptMap(link("q5", "side"), graph).nodes);
    expect(map.leaf).toEqual({ covered: 1, own: 0, linked: false });
    expect(map.other).toEqual({ covered: 1, own: 0, linked: false });
    expect(map.root).toEqual({ covered: 1, own: 0, linked: false });
    expect(map.side).toEqual({ covered: 1, own: 1, linked: true });
  });

  it("counts a question on two siblings in each sibling and once in their parent", () => {
    const map = byId(conceptMap(link("q2", "mid", "other"), graph).nodes);
    expect(map.mid!.covered).toBe(1);
    expect(map.other!.covered).toBe(1);
    expect(map.root).toEqual({ covered: 1, own: 0, linked: false });
  });

  it("leaves out of own a question also linked to a narrower concept", () => {
    const map = byId(conceptMap([...link("q3", "root"), ...link("q4", "root", "mid")], graph).nodes);
    expect(map.root).toEqual({ covered: 2, own: 1, linked: true });
    expect(map.mid).toEqual({ covered: 1, own: 1, linked: true });
  });

  it("an ancestor reached only from below is not linked, owns nothing and covers what is under it", () => {
    const map = byId(conceptMap([...link("q1", "leaf"), ...link("q9", "leaf")], [...graph, b("root", "top")]).nodes);
    expect(map.top).toEqual({ covered: 2, own: 0, linked: false });
    expect(map.mid).toEqual({ covered: 2, own: 0, linked: false });
    expect(map.side).toBeUndefined();
  });

  it("follows broader edges only: a concept merely related is neither reached nor covered", () => {
    // `related` edges are not an input at all: `lonely` stands alone.
    const map = conceptMap([...link("q3", "root"), ...link("q6", "lonely")], graph);
    expect(byId(map.nodes)).toEqual({
      lonely: { covered: 1, own: 1, linked: true },
      root: { covered: 1, own: 1, linked: true },
    });
    expect(map.broader).toEqual([]);
  });

  it("keeps only the edges among the reach, sorted", () => {
    const map = conceptMap(link("q5", "side"), [b("unrelated", "root"), ...graph]);
    expect(map.broader).toEqual([b("leaf", "mid"), b("mid", "root"), b("other", "root"), b("side", "leaf"), b("side", "other")]);
  });

  it("maps nothing for no link", () => {
    expect(conceptMap([], graph)).toEqual({ nodes: [], broader: [] });
  });

  it("terminates on a stored cycle", () => {
    const map = byId(conceptMap(link("q1", "x"), [b("x", "y"), b("y", "x")]).nodes);
    expect(map).toEqual({
      x: { covered: 1, own: 1, linked: true },
      y: { covered: 1, own: 0, linked: false },
    });
  });
});
