import { describe, expect, it } from "vitest";

import { toSvg, type Drawing, type DrawingItem } from "@quiz/docexport";
import { PX_MM } from "@quiz/docexport/typst";

import { BOX, GRID, PORTS } from "../library.js";
import { initialTerminals } from "../logicLibrary.js";
import { halfAdderSchematic, referenceSchematic } from "../testing.js";
import { CIRCUIT_LIBRARY } from "./circuitLibrary.js";
import { atCellScale, CELL_MM, figureHeightMm, figureWidthMm, paletteFigure, schematicFigure } from "./figure.js";
import { LOGIC_ANSI_LIBRARY, LOGIC_IEC_LIBRARY } from "./logicLibrary.js";

const svgOf = (drawing: Drawing): string => {
  const out = toSvg(drawing);
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.svg;
};

/** Every text of a drawing, groups included. */
const textsOf = (items: readonly DrawingItem[]): string[] =>
  items.flatMap((it) => (it.kind === "text" ? [it.text] : it.kind === "g" ? textsOf(it.items) : []));

describe("a schematic as a figure (ADR-126 §1)", () => {
  it("draws the reference schematic as an SVG toSvg accepts, its designators and values as text", () => {
    const figure = schematicFigure(referenceSchematic(), CIRCUIT_LIBRARY, { grid: true });
    const svg = svgOf(figure);
    expect(svg).toContain(">Rsecret 123.4k</text>");
    expect(svg).toContain(">Csecret 100n</text>");
    // The four ports, named inside the box.
    for (const port of ["in+", "in-", "out+", "out-"]) expect(textsOf(figure.items)).toContain(port);
    // One cell of margin around the box, as the screen fits it.
    expect(figure.viewBox).toEqual([-GRID, -GRID, BOX.width + 2 * GRID, BOX.height + 2 * GRID]);
  });

  it("is deterministic, and writes nothing but the closed model's elements", () => {
    const a = svgOf(schematicFigure(referenceSchematic(), CIRCUIT_LIBRARY, { grid: true }));
    const b = svgOf(schematicFigure(referenceSchematic(), CIRCUIT_LIBRARY, { grid: true }));
    expect(a).toBe(b);
    expect(a).not.toMatch(/class=|style=|href|url\(|<image|<use|<script|foreignObject/);
  });

  it("routes a wire stored without its polyline, as the editor would", () => {
    const schematic = referenceSchematic();
    const bare = { ...schematic, wires: schematic.wires.map((w) => ({ ...w, points: [] })) };
    const paths = (d: Drawing) => d.items.filter((it) => it.kind === "path").length;
    expect(paths(schematicFigure(bare, CIRCUIT_LIBRARY))).toBe(paths(schematicFigure(schematic, CIRCUIT_LIBRARY)));
  });

  it("draws a logic circuit in either symbol library, the terminals' names in their pills", () => {
    for (const library of [LOGIC_IEC_LIBRARY, LOGIC_ANSI_LIBRARY]) {
      const figure = schematicFigure(halfAdderSchematic(), library);
      svgOf(figure);
      expect(textsOf(figure.items)).toEqual(expect.arrayContaining(["a", "b", "c", "s", "U1", "U2"]));
    }
    expect(textsOf(schematicFigure(halfAdderSchematic(), LOGIC_IEC_LIBRARY).items)).toEqual(expect.arrayContaining(["&", "=1"]));
  });

  it("draws a palette, one symbol per kind with its code", () => {
    const figure = paletteFigure(
      ["R", "C", "OPAMP", "NPN", "GND"].map((kind) => ({ kind, code: kind })),
      CIRCUIT_LIBRARY,
    );
    svgOf(figure);
    expect(textsOf(figure.items)).toEqual(expect.arrayContaining(["R", "C", "OPAMP", "NPN", "GND"]));
  });
});

describe("a starter at the frame's scale (ADR-126 §4–§5)", () => {
  /** The printed position of canvas point `(x, y)`, in millimetres from the frame's top left. */
  const printed = (drawing: Drawing, x: number, y: number): [number, number] => {
    const g = drawing.items[0]!;
    if (g.kind !== "g" || g.transform === undefined) throw new Error("not a scaled group");
    const [a, , , d, e, f] = g.transform;
    return [(a * x + e) * PX_MM, (d * y + f) * PX_MM];
  };

  /** How far `mm` is from the nearest ruling line, in cells. */
  const offGrid = (mm: number) => Math.abs(mm / CELL_MM - Math.round(mm / CELL_MM));

  it("puts every grid point of the box on a line of the frame's 4 mm ruling, the box one cell in", () => {
    const starter = atCellScale(schematicFigure({ components: [], wires: [] }, CIRCUIT_LIBRARY));
    svgOf(starter);
    expect(printed(starter, 0, 0)).toEqual([CELL_MM, CELL_MM].map((v) => expect.closeTo(v, 2)));
    for (const port of Object.values(PORTS)) {
      const [x, y] = printed(starter, port.x, port.y);
      expect(offGrid(x)).toBeLessThan(0.01);
      expect(offGrid(y)).toBeLessThan(0.01);
    }
    // The 40 × 25 box: 160 × 100 mm, in a frame of a cell's margin.
    const [x1, y1] = printed(starter, BOX.width, BOX.height);
    expect(x1 - CELL_MM).toBeCloseTo(160, 1);
    expect(y1 - CELL_MM).toBeCloseTo(100, 1);
    expect(starter.viewBox[2] * PX_MM).toBeCloseTo(figureWidthMm(CIRCUIT_LIBRARY), 1);
    expect(starter.viewBox[3] * PX_MM).toBeCloseTo(figureHeightMm(CIRCUIT_LIBRARY), 1);
  });

  it("draws the declared terminals of a logic question and nothing else", () => {
    const starter = atCellScale(
      schematicFigure({ components: initialTerminals(["a", "b"], ["y"]), wires: [] }, LOGIC_IEC_LIBRARY),
    );
    svgOf(starter);
    expect(textsOf(starter.items).sort()).toEqual(["a", "b", "y"]);
  });
});
