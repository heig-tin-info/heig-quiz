import { describe, expect, it } from "vitest";

import { EXAMPLES } from "../examples.js";
import { estimateText, rectOf } from "../geometry.js";
import { layout } from "../layout.js";
import { MAX_INK_POINTS, MAX_LINKS, MAX_NODES_STRUCTURED, MAX_VIA, type Scene } from "../scene.js";
import {
  addElement,
  addInk,
  addLink,
  carried,
  duplicateSelection,
  elementAt,
  hintFor,
  insertElbow,
  moveBy,
  newElement,
  nextName,
  removeElbow,
  removeSelection,
  resizeTo,
  reverseSelection,
  setInitial,
} from "./ops.js";
import { diagramStrings as S } from "./strings.js";

const empty: Scene = { nodes: [], links: [] };

describe("names and new elements", () => {
  it("counts per kind of name", () => {
    const scene: Scene = { nodes: [{ id: "aaaa", t: "astate", x: 0, y: 0, name: "q0" }, { id: "bbbb", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    expect(nextName(scene, "astate", S)).toBe("q1");
    expect(nextName(scene, "vertex", S)).toBe("B");
    expect(nextName(scene, "class", S)).toBe("Class1");
    expect(nextName({ nodes: [{ id: "cccc", t: "terminal", x: 0, y: 0, name: "Start" }], links: [] }, "terminal", S)).toBe("End");
    expect(nextName(scene, "initial", S)).toBe("");
  });

  it("centres a new element on the grid, the first automaton state initial", () => {
    const n = newElement(empty, "astate", { x: 101, y: 99 }, estimateText, S);
    expect(n).toMatchObject({ t: "astate", name: "q0", initial: true, x: 80, y: 80 });
    const accept = newElement({ nodes: [n], links: [] }, "accept", { x: 0, y: 0 }, estimateText, S);
    expect(accept).toMatchObject({ t: "astate", accept: true, name: "q1" });
    expect(accept.initial).toBeUndefined();
    expect(newElement(empty, "rect", { x: 0, y: 0 }, estimateText, S)).toMatchObject({ w: 100, h: 60 });
  });

  it("turns points into a stroke boxed at its top left", () => {
    expect(addInk(empty, "free", "line", [[30, 50], [10, 10]]).nodes[0]).toMatchObject({ t: "line", x: 10, y: 10, w: 20, h: 40, pts: [[20, 40], [0, 0]] });
  });
});

describe("the limits of the schema", () => {
  it("adds no element, link, elbow or ink past its limit", () => {
    const full: Scene = { nodes: Array.from({ length: MAX_NODES_STRUCTURED }, (_, i) => ({ id: `v${String(i).padStart(3, "0")}`, t: "vertex" as const, x: 0, y: 0 })), links: [] };
    expect(addElement(full, "graph", newElement(full, "vertex", { x: 0, y: 0 }, estimateText, S))).toBe(full);
    expect(duplicateSelection(full, "graph", new Set(["v000"]))).toBeNull();

    const linked: Scene = { ...EXAMPLES.graph, links: Array.from({ length: MAX_LINKS }, (_, i) => ({ id: `e${String(i).padStart(3, "0")}`, type: "edge" as const, a: "n001", b: "n002" })) };
    expect(addLink(linked, "edge", "n001", "n003", [])).toBeNull();

    const { routes } = layout(EXAMPLES.flow, "flow", estimateText);
    const elbows = Array.from({ length: MAX_VIA }, (_, i) => ({ x: 260, y: 300 + i * 20 }));
    const bent: Scene = { ...EXAMPLES.flow, links: EXAMPLES.flow.links.map((l) => (l.id === "l006" ? { ...l, via: elbows } : l)) };
    expect(insertElbow(bent, "l006", routes.get("l006")!, { x: 0, y: 0 }).links[5]?.via).toHaveLength(MAX_VIA);

    const inked = addInk(empty, "free", "stroke", Array.from({ length: MAX_INK_POINTS }, (_, i) => [i % 100, 0] as const));
    expect(addInk(inked, "free", "line", [[0, 0], [10, 10]])).toBe(inked);
  });
});

describe("editing", () => {
  it("moves a boundary with what it holds, and the elbows of the links it carries", () => {
    expect(carried(EXAMPLES.usecase, new Set(["n001"]), estimateText)).toEqual(new Set(["n001", "n005", "n006", "n007", "n008", "n009"]));
    const moved = moveBy(EXAMPLES.flow, new Set(["n006", "n004"]), new Set(), 20, 0);
    expect(moved.links.find((l) => l.id === "l006")?.via).toEqual([{ x: 280, y: 500 }, { x: 280, y: 300 }]);
  });

  it("deletes a node with its links, duplicates with the links between the copies", () => {
    const gone = removeSelection(EXAMPLES.graph, new Set(["n001"]));
    expect(gone.links.some((l) => l.a === "n001" || l.b === "n001")).toBe(false);
    const copy = duplicateSelection(EXAMPLES.graph, "graph", new Set(["n001", "n002"]));
    expect(copy?.scene.nodes).toHaveLength(8);
    expect(copy?.scene.links).toHaveLength(10);
    expect(copy?.ids.size).toBe(3);
  });

  it("reverses a link's ends, end labels and elbows", () => {
    expect(reverseSelection(EXAMPLES.class, new Set(["l005"])).links[4]).toMatchObject({ a: "n006", b: "n001", ma: "1", mb: "0..*" });
  });

  it("puts an elbow in its place along the line, and takes it out", () => {
    const { routes } = layout(EXAMPLES.flow, "flow", estimateText);
    const route = routes.get("l006")!;
    const before = route.pts[1]!;
    expect(insertElbow(EXAMPLES.flow, "l006", route, { x: before[0], y: before[1] }).links[5]?.via).toHaveLength(3);
    expect(removeElbow(removeElbow(EXAMPLES.flow, "l006", 0), "l006", 0).links[5]?.via).toBeUndefined();
  });

  it("resizes from the corner, a circle staying round and a boundary not too small", () => {
    const circle: Scene = { nodes: [{ id: "cccc", t: "circle", x: 0, y: 0, w: 60, h: 60 }], links: [] };
    expect(resizeTo(circle, "cccc", { x: 100, y: 40 }).nodes[0]).toMatchObject({ w: 100, h: 100 });
    expect(resizeTo(EXAMPLES.usecase, "n001", { x: 260, y: 40 }).nodes[0]).toMatchObject({ w: 160, h: 120 });
  });

  it("keeps one initial state", () => {
    expect(setInitial(EXAMPLES.automaton, "n002", true).nodes.filter((n) => n.initial).map((n) => n.id)).toEqual(["n002"]);
  });

  it("hints at what the editor is doing", () => {
    const base = { tool: null, drawing: false, selected: 0, kind: "class" as const };
    expect(hintFor({ ...base, mode: "select" })).toBe("hintSelect");
    expect(hintFor({ ...base, mode: "select", kind: "free" })).toBe("hintSelectFree");
    expect(hintFor({ ...base, mode: "place", tool: "stroke" })).toBe("hintInk");
    expect(hintFor({ ...base, mode: "link", drawing: true })).toBe("hintDrawing");
  });
});

describe("elementAt", () => {
  it("finds an element and its border, a system only by its title or its frame", () => {
    const { rects } = layout(EXAMPLES.usecase, "usecase", estimateText);
    const sys = rectOf(EXAMPLES.usecase.nodes[0]!, estimateText);
    expect(elementAt(EXAMPLES.usecase, rects, sys.x0 + 60, sys.y0 + 10, 6)).toEqual({ id: "n001", edge: false });
    expect(elementAt(EXAMPLES.usecase, rects, sys.x0 + 30, sys.y1 - 30, 6)).toBeNull();
    expect(elementAt(EXAMPLES.usecase, rects, sys.x0 + 60, sys.y0 + 10, 6, false)).toBeNull();
    const cat = rects.get("n005")!;
    expect(elementAt(EXAMPLES.usecase, rects, cat.x0 + cat.w / 2, cat.y0 + cat.h / 2, 6)).toEqual({ id: "n005", edge: false });
    expect(elementAt(EXAMPLES.usecase, rects, cat.x0 + 1, cat.y0 + cat.h / 2, 6)).toEqual({ id: "n005", edge: true });
  });

  it("hits a stroke near its path only", () => {
    const { rects } = layout(EXAMPLES.free, "free", estimateText);
    expect(elementAt(EXAMPLES.free, rects, 300, 321, 4)?.id).toBe("n006");
    expect(elementAt(EXAMPLES.free, rects, 60, 340, 4)).toBeNull();
  });
});
