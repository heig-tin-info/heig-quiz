/**
 * `logic`'s two component libraries, as the canvas reads them (ADR-123 §5):
 * the part table of `../logicLibrary.ts` drawn in IEC 60617 (rectangles with
 * their qualifying symbol, `&`, `≥1`, `=1`, `1`) or in ANSI (distinctive
 * shapes). The teacher picks one; the student draws with it. Both are module
 * constants, as `SchematicLibrary` asks.
 *
 * A declared terminal is a rounded rectangle bearing its name, as wide as
 * the name needs: a one-letter name is a circle. Its pin sits at the end of
 * the pill, on the side the wire leaves.
 */
import { LOGIC_BOX, LOGIC_KINDS, LOGIC_PARTS, NEGATED, PILL_HEIGHT, type LogicPartSpec } from "../logicLibrary.js";

import type { SchematicLibrary } from "./schematicLibrary.js";
import type { SymbolShape, SymbolSpec, SymbolText } from "./symbols.js";

export type LogicSymbolStyle = "iec" | "ansi";

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A circle as a path: the negation bubble. */
const bubble = (cx: number): SymbolShape => ({
  paint: "hollow",
  d: `M${cx - 4} 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0`,
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

/** A name's pill: as wide as the name needs at the canvas's 11 px mono, a circle for one letter. */
export const pillWidth = (name: string): number => Math.max(PILL_HEIGHT, Math.ceil(name.length * 6.6 + 12));

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

function libraryOf(style: LogicSymbolStyle): SchematicLibrary {
  const gates = new Map<string, SymbolSpec>(
    LOGIC_KINDS.filter((kind) => LOGIC_PARTS.part(kind).family !== null).map((kind) => {
      const spec = LOGIC_PARTS.part(kind);
      return [kind, style === "iec" ? iecGate(spec) : ansiGate(spec)] as const;
    }),
  );
  return {
    box: LOGIC_BOX,
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
