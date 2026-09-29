import { describe, expect, it } from "vitest";

import { EXAMPLES } from "./examples.js";
import { DIAGRAM_KINDS, kindIssues } from "./kinds.js";
import { MAX_INK_POINTS, MAX_NODES_STRUCTURED, SceneSchema, emptyScene, newId, sameScene, type Scene } from "./scene.js";

describe("SceneSchema", () => {
  it("accepts every example", () => {
    for (const kind of DIAGRAM_KINDS) expect(SceneSchema.safeParse(EXAMPLES[kind]).success, kind).toBe(true);
  });

  it("refuses an unknown field, an id that is not opaque, a coordinate out of bounds", () => {
    const node = { id: "abcd", t: "class", x: 0, y: 0 };
    expect(SceneSchema.safeParse({ nodes: [{ ...node, extra: 1 }], links: [] }).success).toBe(false);
    expect(SceneSchema.safeParse({ nodes: [{ ...node, id: "Ab/1" }], links: [] }).success).toBe(false);
    expect(SceneSchema.safeParse({ nodes: [{ ...node, x: 20_001 }], links: [] }).success).toBe(false);
  });

  it("refuses a duplicate id and a link to nowhere", () => {
    const a = { id: "aaaa", t: "class", x: 0, y: 0 } as const;
    expect(SceneSchema.safeParse({ nodes: [a, a], links: [] }).success).toBe(false);
    expect(SceneSchema.safeParse({ nodes: [a], links: [{ id: "llll", type: "assoc", a: "aaaa", b: "zzzz" }] }).success).toBe(false);
  });

  it("caps the freehand points of a whole scene", () => {
    const stroke = (id: string, n: number) => ({ id, t: "stroke", x: 0, y: 0, pts: Array.from({ length: n }, (_, i) => [i, 0]) });
    const half = MAX_INK_POINTS / 2;
    expect(SceneSchema.safeParse({ nodes: [stroke("aaaa", half), stroke("bbbb", half)], links: [] }).success).toBe(true);
    expect(SceneSchema.safeParse({ nodes: [stroke("aaaa", half), stroke("bbbb", half + 1)], links: [] }).success).toBe(false);
  });
});

describe("kindIssues", () => {
  it("finds nothing wrong in an example of its own kind", () => {
    for (const kind of DIAGRAM_KINDS) expect(kindIssues(EXAMPLES[kind], kind), kind).toEqual([]);
  });

  it("names an element, a link of another kind, and too many elements", () => {
    expect(kindIssues(EXAMPLES.graph, "automaton")).toEqual(["diagram.node_type", "diagram.link_type"]);
    const crowded: Scene = {
      nodes: Array.from({ length: MAX_NODES_STRUCTURED + 1 }, (_, i) => ({ id: `v${String(i).padStart(3, "0")}`, t: "vertex", x: 0, y: 0 })),
      links: [],
    };
    expect(kindIssues(crowded, "graph")).toEqual(["diagram.too_many_nodes"]);
  });
});

describe("sameScene", () => {
  it("ignores the order of the keys and the absent fields, not the content", () => {
    const a: Scene = { nodes: [{ id: "aaaa", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    const b: Scene = { nodes: [{ name: "A", y: 0, x: 0, t: "vertex", id: "aaaa" }], links: [] };
    expect(sameScene(a, b)).toBe(true);
    expect(sameScene(a, { nodes: [{ ...a.nodes[0]!, x: 20 }], links: [] })).toBe(false);
    expect(sameScene(emptyScene(), emptyScene())).toBe(true);
  });
});

it("mints opaque ids", () => {
  const ids = new Set(Array.from({ length: 100 }, newId));
  expect(ids.size).toBe(100);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
});
