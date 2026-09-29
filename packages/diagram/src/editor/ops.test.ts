import { describe, expect, it } from "vitest";

import { EXAMPLES } from "../examples.js";
import { estimateText, rectOf } from "../geometry.js";
import { layout } from "../layout.js";
import type { Scene } from "../scene.js";
import {
  carried,
  duplicateSelection,
  elementAt,
  inkElement,
  insertElbow,
  moveBy,
  newElement,
  nextName,
  removeElbow,
  removeSelection,
  reverseSelection,
  setInitial,
  type NewNames,
} from "./ops.js";

const WORDS: NewNames = {
  class: "Class",
  actor: "Actor",
  usecase: "Case",
  system: "System",
  state: "State",
  entity: "Entity",
  start: "Start",
  end: "End",
  action: "Action",
  decision: "Condition",
};

describe("names and new elements", () => {
  it("counts per kind of name", () => {
    const scene: Scene = { nodes: [{ id: "aaaa", t: "astate", x: 0, y: 0, name: "q0" }, { id: "bbbb", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    expect(nextName(scene, "astate", WORDS)).toBe("q1");
    expect(nextName(scene, "vertex", WORDS)).toBe("B");
    expect(nextName(scene, "class", WORDS)).toBe("Class1");
    expect(nextName({ nodes: [{ id: "cccc", t: "terminal", x: 0, y: 0, name: "Start" }], links: [] }, "terminal", WORDS)).toBe("End");
    expect(nextName(scene, "initial", WORDS)).toBe("");
  });

  it("centres a new element on the grid, the first automaton state initial", () => {
    const n = newElement({ nodes: [], links: [] }, "astate", { x: 101, y: 99 }, estimateText, WORDS);
    expect(n).toMatchObject({ t: "astate", name: "q0", initial: true, x: 80, y: 80 });
    const accept = newElement({ nodes: [n], links: [] }, "accept", { x: 0, y: 0 }, estimateText, WORDS);
    expect(accept).toMatchObject({ t: "astate", accept: true, name: "q1" });
    expect(accept.initial).toBeUndefined();
    expect(newElement({ nodes: [], links: [] }, "rect", { x: 0, y: 0 }, estimateText, WORDS)).toMatchObject({ w: 100, h: 60 });
  });

  it("turns points into a stroke boxed at its top left", () => {
    expect(inkElement("line", [[30, 50], [10, 10]])).toMatchObject({ t: "line", x: 10, y: 10, w: 20, h: 40, pts: [[20, 40], [0, 0]] });
  });
});

describe("editing", () => {
  const scene = EXAMPLES.usecase;

  it("moves a boundary with what it holds, and the elbows of the links it carries", () => {
    const ids = carried(scene, new Set(["n001"]), estimateText);
    expect(ids).toEqual(new Set(["n001", "n005", "n006", "n007", "n008", "n009"]));
    const moved = moveBy(EXAMPLES.flow, new Set(["n006", "n004"]), new Set(), 20, 0);
    expect(moved.links.find((l) => l.id === "l006")?.via).toEqual([{ x: 280, y: 500 }, { x: 280, y: 300 }]);
  });

  it("deletes a node with its links, duplicates with the links between the copies", () => {
    const gone = removeSelection(EXAMPLES.graph, new Set(["n001"]));
    expect(gone.links.some((l) => l.a === "n001" || l.b === "n001")).toBe(false);
    const { scene: dup, ids } = duplicateSelection(EXAMPLES.graph, new Set(["n001", "n002"]));
    expect(dup.nodes).toHaveLength(8);
    expect(dup.links).toHaveLength(10);
    expect(ids.size).toBe(3);
  });

  it("reverses a link's ends, end labels and elbows", () => {
    const flipped = reverseSelection(EXAMPLES.class, new Set(["l005"]));
    expect(flipped.links[4]).toMatchObject({ a: "n006", b: "n001", ma: "1", mb: "0..*" });
  });

  it("puts an elbow in its place along the line, and takes it out", () => {
    const { routes } = layout(EXAMPLES.flow, "flow", estimateText);
    const route = routes.get("l006")!;
    const before = route.pts[1]!;
    const withElbow = insertElbow(EXAMPLES.flow, "l006", route, { x: before[0], y: before[1] });
    expect(withElbow.links[5]?.via).toHaveLength(3);
    expect(removeElbow(removeElbow(EXAMPLES.flow, "l006", 0), "l006", 0).links[5]?.via).toBeUndefined();
  });

  it("keeps one initial state", () => {
    const next = setInitial(EXAMPLES.automaton, "n002", true);
    expect(next.nodes.filter((n) => n.initial).map((n) => n.id)).toEqual(["n002"]);
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
