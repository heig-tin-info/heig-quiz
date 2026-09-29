import { describe, expect, it } from "vitest";

import { applyParsed } from "./apply.js";
import { parseText } from "./codecs/index.js";
import { EXAMPLES } from "./examples.js";
import { estimateText, rectOf, type Rect } from "./geometry.js";
import { DIAGRAM_KINDS, KINDS } from "./kinds.js";
import { layout } from "./layout.js";
import type { Scene } from "./scene.js";

const strictlyInside = (r: Rect, [x, y]: readonly [number, number]): boolean => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;

describe("orthogonal layout", () => {
  const kinds = DIAGRAM_KINDS.filter((k) => KINDS[k].lines === "orthogonal" && k !== "free");

  it.each(kinds)("%s: every link is routed, and no vertex falls inside a box", (kind) => {
    const scene = EXAMPLES[kind];
    const { routes, rects } = layout(scene, kind, estimateText);
    expect([...routes.keys()]).toEqual(scene.links.map((l) => l.id));
    const boxes = scene.nodes.filter((n) => n.t !== "system").map((n) => rects.get(n.id) as Rect);
    for (const route of routes.values()) for (const p of route.pts.slice(1, -1)) for (const r of boxes) expect(strictlyInside(r, p)).toBe(false);
  });

  it("spreads the ends sharing a side, and spills to the next side when one is full", () => {
    /* a state 40 high has one free point on its left and right sides */
    const { routes } = layout(EXAMPLES.state, "state", estimateText);
    const fermee = rectOf(EXAMPLES.state.nodes[1]!, estimateText);
    const ends = EXAMPLES.state.links.flatMap((l) => {
      const r = routes.get(l.id)!;
      return [l.a === "n002" ? r.a : null, l.b === "n002" ? r.b : null].filter((e) => e !== null);
    });
    const keys = ends.map((e) => `${e.x},${e.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of ends) expect(e.x === fermee.x0 || e.x === fermee.x1 || e.y === fermee.y0 || e.y === fermee.y1).toBe(true);
  });

  it("gives each end of a decision its own vertex", () => {
    const { routes } = layout(EXAMPLES.flow, "flow", estimateText);
    const test = rectOf(EXAMPLES.flow.nodes[3]!, estimateText);
    const vertices = EXAMPLES.flow.links.flatMap((l) => {
      const r = routes.get(l.id)!;
      return [l.a === "n004" ? r.a : null, l.b === "n004" ? r.b : null].filter((e) => e !== null);
    });
    expect(vertices).toHaveLength(4);
    expect(new Set(vertices.map((e) => e.d)).size).toBe(4);
    const cx = (test.x0 + test.x1) / 2;
    const cy = (test.y0 + test.y1) / 2;
    for (const e of vertices) expect(e.x === cx || e.y === cy).toBe(true);
  });

  it("slides an end onto a use case's ellipse", () => {
    const { routes, rects } = layout(EXAMPLES.usecase, "usecase", estimateText);
    const catalogue = rects.get("n005")!;
    const end = routes.get("l001")!.b;
    const a = catalogue.w / 2;
    const b = catalogue.h / 2;
    const k = ((end.x - catalogue.x0 - a) / a) ** 2 + ((end.y - catalogue.y0 - b) / b) ** 2;
    expect(k).toBeCloseTo(1, 5);
  });

  it("routes a link being drawn to a free point", () => {
    const { routes } = layout(EXAMPLES.class, "class", estimateText, { id: "draft", type: "assoc", a: "n001", b: { x: 1000, y: 700 }, via: [] });
    const route = routes.get("draft")!;
    expect(route.pts[route.pts.length - 1]).toEqual([1000, 700]);
  });
});

describe("straight layout", () => {
  it("bends a pair's two lines apart, loops over a self transition, passes through an elbow", () => {
    const { routes } = layout(EXAMPLES.automaton, "automaton", estimateText);
    const there = routes.get("l004")!;
    const back = routes.get("l005")!;
    expect(there.path).toMatch(/Q/);
    expect(back.path).toMatch(/Q/);
    expect(Math.sign(there.label!.y - 180)).not.toBe(Math.sign(back.label!.y - 180));
    expect(routes.get("l001")!.path).toMatch(/C/);
    expect(routes.get("l006")!.pts).toContainEqual([340, 300]);
  });

  it("starts and ends every line on its circle", () => {
    const { routes, rects } = layout(EXAMPLES.graph, "graph", estimateText);
    for (const l of EXAMPLES.graph.links) {
      const route = routes.get(l.id)!;
      for (const [id, end] of [
        [l.a, route.a],
        [l.b, route.b],
      ] as const) {
        const r = rects.get(id)!;
        expect(Math.hypot(end.x - (r.x0 + r.x1) / 2, end.y - (r.y0 + r.y1) / 2)).toBeCloseTo(r.w / 2, 5);
      }
    }
  });
});

describe("applyParsed placement", () => {
  const add = (scene: Scene, kind: "flow" | "usecase" | "automaton", text: string): Scene =>
    applyParsed(scene, parseText(text, kind), kind, estimateText);

  it("puts a new flowchart step under the one that leads to it, clear of the rest", () => {
    const text = "flowchart TD\n  n1([Début]) --> n2[Lire n]\n  n2 --> n3[Nouvelle étape]";
    const scene = add({ nodes: [EXAMPLES.flow.nodes[0]!, EXAMPLES.flow.nodes[1]!], links: [] }, "flow", text);
    const lire = rectOf(scene.nodes[1]!, estimateText);
    const step = rectOf(scene.nodes[2]!, estimateText);
    expect(step.y0).toBe(lire.y1 + 40);
    expect((step.x0 + step.x1) / 2).toBe((lire.x0 + lire.x1) / 2);
  });

  it("stacks a new use case inside its boundary and grows it", () => {
    const text = 'rectangle "Boutique en ligne" {\n  usecase "Suivre une livraison" as X\n}\nactor Client\nClient -- X';
    const scene = add({ nodes: [EXAMPLES.usecase.nodes[0]!, EXAMPLES.usecase.nodes[1]!], links: [] }, "usecase", text);
    const sys = rectOf(scene.nodes[0]!, estimateText);
    const uc = rectOf(scene.nodes[1]!, estimateText);
    expect(uc.x0).toBe(sys.x0 + 40);
    expect(uc.y1).toBeLessThanOrEqual(sys.y1);
  });

  it("puts a new automaton state right of its source", () => {
    const text = "digraph {\n  q0\n  q0 -> q1\n}";
    const scene = add({ nodes: [EXAMPLES.automaton.nodes[0]!], links: [] }, "automaton", text);
    expect(scene.nodes[1]!.x).toBeGreaterThan(rectOf(scene.nodes[0]!, estimateText).x1);
  });
});
