import { describe, expect, it } from "vitest";

import { toSvg, type DrawingItem } from "@quiz/docexport";

import { EXAMPLES } from "./examples.js";
import { GRID, estimateText } from "./geometry.js";
import { DIAGRAM_KINDS } from "./kinds.js";
import { layout } from "./layout.js";
import { TEXT_ROLES, paintLink, paintNode, type Prim } from "./paint.js";
import { figure, monoMeasure } from "./print.js";
import { emptyScene } from "./scene.js";

/** Every item of a drawing, groups opened. */
const flat = (items: readonly DrawingItem[]): DrawingItem[] => items.flatMap((it) => (it.kind === "g" ? flat(it.items) : [it]));

const textsOf = (items: readonly DrawingItem[]): string[] => flat(items).flatMap((it) => (it.kind === "text" ? [it.text] : []));

describe("the geometry as primitives (ADR-126 §1)", () => {
  it.each(DIAGRAM_KINDS)("paints every element and link of a %s with a role, texts in a text role", (kind) => {
    const scene = EXAMPLES[kind];
    const lay = layout(scene, kind, estimateText);
    const prims: Prim[] = [
      ...scene.nodes.flatMap((n) => paintNode(n, estimateText)),
      ...scene.links.flatMap((l) => paintLink(l, lay.routes.get(l.id)!)),
    ];
    expect(prims.length).toBeGreaterThan(0);
    for (const p of prims) expect(p.el === "text").toBe(TEXT_ROLES.has(p.role));
  });

  it("leaves the labels out of a toolbox icon", () => {
    const route = { pts: [[4, 15], [40, 15]] as const, a: { x: 4, y: 15, d: 0 }, b: { x: 40, y: 15, d: 2 } } as const;
    const prims = paintLink({ type: "nav", name: "owns", ma: "1", mb: "0..*" }, { ...route, pts: [[4, 15], [40, 15]] }, false);
    expect(prims.some((p) => p.el === "text")).toBe(false);
    expect(prims.map((p) => p.role)).toEqual(["line", "headOpen"]);
  });
});

describe("a scene as a printed figure (ADR-126)", () => {
  it.each(DIAGRAM_KINDS)("draws the %s example: deterministic, accepted by toSvg, every name in it", (kind) => {
    const scene = EXAMPLES[kind];
    const drawing = figure(scene, kind)!;
    expect(figure(scene, kind)).toEqual(drawing);
    const svg = toSvg(drawing);
    expect(svg.ok).toBe(true);
    if (!svg.ok) return;
    // The writer's rules hold: nothing of a page's styling, a link or a script.
    expect(svg.svg).not.toMatch(/\sclass=|\sstyle=|href|<image|<use|foreignObject|<script|url\(|var\(/);
    for (const name of scene.nodes.flatMap((n) => (n.name ? [n.name] : []))) {
      // A wrapped name is its lines, one after the other.
      expect(textsOf(drawing.items).join(" ")).toContain(name);
    }
  });

  it("frames the content on the editor's grid, with room around it", () => {
    const drawing = figure(EXAMPLES.class, "class")!;
    const [x, y, w, h] = drawing.viewBox;
    for (const v of [x, y, w, h]) expect(Math.abs(v % GRID)).toBe(0);
    const lay = layout(EXAMPLES.class, "class", monoMeasure);
    for (const r of lay.rects.values()) {
      expect(r.x0).toBeGreaterThanOrEqual(x + GRID);
      expect(r.x1).toBeLessThanOrEqual(x + w - GRID);
    }
  });

  it("is nothing for an empty scene", () => {
    expect(figure(emptyScene(), "class")).toBeNull();
  });

  it("measures in the printed face: a box is as wide as its monospace name", () => {
    const name = "AVeryLongClassNameIndeed";
    const node = { id: "n1", t: "class" as const, x: 0, y: 0, name };
    const outline = paintNode(node, monoMeasure).find((p) => p.role === "outline");
    expect(outline?.el === "rect" && outline.w).toBeGreaterThanOrEqual(name.length * 13.5 * 0.602);
  });

  it("paints a dashed line, an underlined member, an italic abstract name, a grounded label", () => {
    const scene = {
      nodes: [
        { id: "a", t: "class" as const, x: 0, y: 0, name: "Shape", abstract: true, body: ["+ count : int {static}"] },
        { id: "b", t: "class" as const, x: 0, y: 200, name: "Drawable" },
      ],
      links: [
        { id: "l1", type: "impl" as const, a: "a", b: "b" },
        { id: "l2", type: "assoc" as const, a: "a", b: "b", name: "uses", ma: "1" },
      ],
    };
    const items = flat(figure(scene, "class")!.items);
    expect(items.some((it) => it.kind === "path" && it.dash !== undefined)).toBe(true);
    expect(items.find((it) => it.kind === "text" && it.text === "Shape")).toMatchObject({ italic: true, weight: "bold" });
    const member = items.findIndex((it) => it.kind === "text" && it.text === "+ count : int");
    expect(items[member + 1]?.kind).toBe("line");
    const label = items.findIndex((it) => it.kind === "text" && it.text === "uses");
    expect(items[label - 1]).toMatchObject({ kind: "rect", fill: "paper", stroke: "none" });
  });

  it("writes a hostile name as text, escaped", () => {
    const scene = { nodes: [{ id: "a", t: "class" as const, x: 0, y: 0, name: "<script>&\"x\"" }], links: [] };
    const svg = toSvg(figure(scene, "class")!);
    expect(svg.ok && svg.svg).toContain("&#60;script&#62;&#38;&#34;x&#34;");
  });
});
