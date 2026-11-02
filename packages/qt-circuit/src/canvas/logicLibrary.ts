/**
 * `logic`'s two component libraries, as the canvas reads them (ADR-123 §5):
 * the part table of `../logicLibrary.ts` drawn in IEC 60617 (rectangles with
 * their qualifying symbol, `&`, `≥1`, `=1`, `1`) or in ANSI (distinctive
 * shapes). The teacher picks one; the student draws with it. Both are module
 * constants, as `SchematicLibrary` asks.
 *
 * A latch or a flip-flop is a box in both styles, its inputs labelled
 * inside, an edge-triggered clock marked by the dynamic-input triangle. IEC
 * 60617 qualifies the inputs (`1D`, `C1`, `S`, `R`) and puts a negation
 * circle on `Q̄`; ANSI names every pin (`D`, `EN`, `Q`, `Q̄`).
 *
 * A declared terminal is a rounded rectangle bearing its name, as wide as
 * the name needs: a one-letter name is a circle. Its pin sits at the end of
 * the pill, on the side the wire leaves.
 */
import { BOX } from "../library.js";
import { GRID } from "../library.js";
import { LOGIC_KINDS, LOGIC_PARTS, NEGATED, PILL_HEIGHT, type LogicPartSpec } from "../logicLibrary.js";

import type { SchematicLibrary } from "./schematicLibrary.js";
import type { SymbolShape, SymbolSpec, SymbolText } from "./symbols.js";

export type LogicSymbolStyle = "iec" | "ansi";

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A circle as a path: the negation bubble. */
const bubble = (cx: number, cy = 0): SymbolShape => ({
  paint: "hollow",
  d: `M${cx - 4} ${cy}a4 4 0 1 0 8 0a4 4 0 1 0 -8 0`,
});

/** The output lead from `x` to the pin, through the bubble when the gate negates. */
function output(spec: LogicPartSpec, x: number): SymbolShape[] {
  const negated = spec.family !== null && NEGATED.has(spec.family);
  return negated ? [bubble(x + 4), { paint: "stroke", d: `M${x + 8} 0H40` }] : [{ paint: "stroke", d: `M${x} 0H40` }];
}

/** Each input's lead, from its pin to where the body begins at that height. */
const inputs = (spec: LogicPartSpec, backAt: (y: number) => number): SymbolShape => ({
  paint: "stroke",
  d: spec.pins
    .slice(0, -1)
    .map((pin) => `M${pin.x} ${pin.y}H${r2(backAt(pin.y))}`)
    .join(""),
});

const viewBox = (half: number): string => `-46 ${-half - 6} 92 ${2 * half + 12}`;

const IEC_QUALIFIER: Readonly<Record<string, string>> = {
  AND: "&",
  NAND: "&",
  OR: "≥1",
  NOR: "≥1",
  XOR: "=1",
  XNOR: "=1",
  NOT: "1",
  BUF: "1",
};

function iecGate(spec: LogicPartSpec): SymbolSpec {
  const h = spec.half;
  return {
    shapes: [inputs(spec, () => -20), { paint: "hollow", d: `M-20 ${-h}H20V${h}H-20Z` }, ...output(spec, 20)],
    marks: [],
    texts: [{ x: 0, y: 0, text: IEC_QUALIFIER[spec.family ?? ""] ?? "" }],
    viewBox: viewBox(h),
  };
}

/** The concave back of an OR, as a quadratic from (x, −h) through (x + 12, 0) to (x, h). */
const orBack = (x: number, h: number) => (y: number): number => {
  const t = (y / h + 1) / 2;
  return x + 24 * t * (1 - t);
};

function ansiGate(spec: LogicPartSpec): SymbolSpec {
  const h = spec.half;
  const family = spec.family ?? "";
  if (family === "NOT" || family === "BUF") {
    return {
      shapes: [inputs(spec, () => -20), { paint: "hollow", d: "M-20 -16L14 0L-20 16Z" }, ...output(spec, 14)],
      marks: [],
      viewBox: viewBox(h),
    };
  }
  if (family === "AND" || family === "NAND") {
    return {
      shapes: [inputs(spec, () => -20), { paint: "hollow", d: `M-20 ${-h}H0A20 ${h} 0 0 1 0 ${h}H-20Z` }, ...output(spec, 20)],
      marks: [],
      viewBox: viewBox(h),
    };
  }
  // OR, NOR, XOR, XNOR: the shield, and for an exclusive gate a second back.
  const exclusive = family === "XOR" || family === "XNOR";
  const shield: SymbolShape = { paint: "hollow", d: `M-20 ${-h}Q-8 0 -20 ${h}Q6 ${h} 20 0Q6 ${-h} -20 ${-h}Z` };
  return {
    shapes: [
      inputs(spec, orBack(exclusive ? -27 : -20, h)),
      shield,
      ...(exclusive ? [{ paint: "stroke" as const, d: `M-27 ${-h}Q-15 0 -27 ${h}` }] : []),
      ...output(spec, 20),
    ],
    marks: [],
    viewBox: viewBox(h),
  };
}

/** A name's pill: as wide as the name needs at the symbol text's 15 px mono (`symbolText`), a circle for one letter. */
export const pillWidth = (name: string): number => Math.max(PILL_HEIGHT, Math.ceil(name.length * 9 + 14));

/** A terminal (`IN` left of its pin, `OUT` right of it) or a constant (a square with its level). */
function oneSided(kind: string, name: string): SymbolSpec {
  const r = PILL_HEIGHT / 2;
  const level = kind === "LOW" ? "0" : kind === "HIGH" ? "1" : null;
  const text = level ?? name;
  const w = level === null ? pillWidth(text) : PILL_HEIGHT;
  const x0 = kind === "OUT" ? 0 : -w;
  const d =
    level === null
      ? `M${x0 + r} ${-r}H${x0 + w - r}A${r} ${r} 0 0 1 ${x0 + w - r} ${r}H${x0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${-r}Z`
      : `M${x0} ${-r}H${x0 + w}V${r}H${x0}Z`;
  const label: SymbolText = { x: x0 + w / 2, y: 0, text };
  return {
    shapes: [{ paint: "hollow", d }],
    marks: [],
    texts: text === "" ? [] : [label],
    viewBox: `${x0 - 4} ${-r - 4} ${w + 8} ${PILL_HEIGHT + 8}`,
  };
}

/** A memory's input labels by pin, IEC then ANSI; the clock pin of a flip-flop also gets the triangle. */
const MEMORY_LABELS: ReadonlyMap<string, Readonly<Record<LogicSymbolStyle, Readonly<Record<string, string>>>>> = new Map(Object.entries({
  SR: { iec: { S: "S", R: "R" }, ansi: { S: "S", R: "R" } },
  DLATCH: { iec: { D: "1D", EN: "C1" }, ansi: { D: "D", EN: "EN" } },
  DFF: { iec: { D: "1D", CLK: "C1" }, ansi: { D: "D", CLK: "" } },
  JKFF: { iec: { J: "1J", CLK: "C1", K: "1K" }, ansi: { J: "J", CLK: "", K: "K" } },
  TFF: { iec: { T: "1T", CLK: "C1" }, ansi: { T: "T", CLK: "" } },
}));

/** The monospace advance of the symbol text, 15 px (`symbolText`). */
const CHAR = 9;
const TRIANGLE = 7;

function memorySymbol(spec: LogicPartSpec, style: LogicSymbolStyle, labels: Readonly<Record<string, string>>): SymbolSpec {
  const h = spec.half;
  const pins = spec.pins.filter((pin) => pin.x < 0);
  const clock = pins.find((pin) => pin.name === "CLK");
  const left = (pin: { name: string; y: number }): SymbolText => {
    const text = labels[pin.name] ?? "";
    const start = -20 + 4 + (pin.name === "CLK" ? TRIANGLE + 1 : 0);
    return { x: start + (text.length * CHAR) / 2, y: pin.y, text };
  };
  const negated: SymbolShape[] =
    style === "iec" ? [bubble(24, GRID), { paint: "stroke", d: `M28 ${GRID}H40` }] : [{ paint: "stroke", d: `M20 ${GRID}H40` }];
  return {
    shapes: [
      { paint: "stroke", d: pins.map((pin) => `M${pin.x} ${pin.y}H-20`).join("") },
      { paint: "hollow", d: `M-20 ${-h}H20V${h}H-20Z` },
      ...(clock === undefined ? [] : [{ paint: "stroke" as const, d: `M-20 ${clock.y - 5}L${-20 + TRIANGLE} ${clock.y}L-20 ${clock.y + 5}` }]),
      { paint: "stroke", d: `M20 ${-GRID}H40` },
      ...negated,
    ],
    marks: [],
    texts: [
      ...pins.map(left).filter((t) => t.text !== ""),
      ...(style === "ansi"
        ? [
            { x: 20 - 4 - CHAR / 2, y: -GRID, text: "Q" },
            { x: 20 - 4 - CHAR / 2, y: GRID, text: "Q̄" },
          ]
        : []),
    ],
    viewBox: viewBox(h),
  };
}

function libraryOf(style: LogicSymbolStyle): SchematicLibrary {
  const gates = new Map<string, SymbolSpec>(
    LOGIC_KINDS.filter((kind) => LOGIC_PARTS.part(kind).family !== null).map((kind) => {
      const spec = LOGIC_PARTS.part(kind);
      const labels = MEMORY_LABELS.get(kind);
      const symbol =
        labels !== undefined ? memorySymbol(spec, style, labels[style]) : style === "iec" ? iecGate(spec) : ansiGate(spec);
      return [kind, symbol] as const;
    }),
  );
  return {
    box: BOX,
    ports: [],
    kinds: LOGIC_KINDS,
    part: LOGIC_PARTS.part,
    symbol: (kind, name = "") => gates.get(kind) ?? oneSided(kind, name),
    formatValue: String,
    valueIssue: () => null,
  };
}

export const LOGIC_IEC_LIBRARY: SchematicLibrary = libraryOf("iec");
export const LOGIC_ANSI_LIBRARY: SchematicLibrary = libraryOf("ansi");

export const logicLibrary = (style: LogicSymbolStyle): SchematicLibrary =>
  style === "ansi" ? LOGIC_ANSI_LIBRARY : LOGIC_IEC_LIBRARY;
