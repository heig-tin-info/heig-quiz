/**
 * One drawing per {@link ComponentKind}, in LOCAL coordinates, IEC style, on
 * the pins and the body that `library.ts` declares. The library is the
 * contract; this file only obeys it — a symbol whose lead does not end on its
 * pin is a bug, and `symbols.test.ts` checks exactly that.
 *
 * Shapes carry no colour: the renderer paints `stroke-current` and picks the
 * ink by class on the group, so a selected component turns accent and a
 * flagged pin turns danger without a second copy of every path.
 */
import { LIBRARY, type ComponentKind } from "../library.js";

/**
 * How a piece of a symbol is painted.
 *
 * - `stroke`: the ordinary 1.7 hairline;
 * - `thick`:  the heavy butt-capped stroke of a capacitor plate or a diode bar;
 * - `hollow`: stroked and filled with the SURFACE, so a wire behind it does
 *   not show through (the op-amp triangle, the resistor rectangle);
 * - `solid`:  filled with the ink (arrowheads, the diode triangle).
 */
export type SymbolShape =
  | { readonly paint: "stroke"; readonly d: string }
  | { readonly paint: "thick"; readonly d: string }
  | { readonly paint: "hollow"; readonly d: string }
  | { readonly paint: "solid"; readonly d: string };

/** An upright `+` or `−` printed beside a pin; it never turns with the symbol. */
export interface SymbolMark {
  readonly x: number;
  readonly y: number;
  readonly sign: "+" | "-";
}

export interface SymbolSpec {
  readonly shapes: readonly SymbolShape[];
  readonly marks: readonly SymbolMark[];
  /** The `viewBox` that frames the symbol alone, for a palette tile. */
  readonly viewBox: string;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * A filled arrowhead on the segment `from → to`, its tip at `at` of the way
 * along it. Computed rather than typed out: six hand-rounded coordinates per
 * transistor is six chances to draw an arrow that misses its own wire.
 */
function arrowhead(
  from: readonly [number, number],
  to: readonly [number, number],
  at: number,
  size = 8,
): SymbolShape {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tx = from[0] + dx * at;
  const ty = from[1] + dy * at;
  const bx = tx - ux * size;
  const by = ty - uy * size;
  const w = size * 0.42;
  const p1x = bx - uy * w;
  const p1y = by + ux * w;
  const p2x = bx + uy * w;
  const p2y = by - ux * w;
  return {
    paint: "solid",
    d: `M${r2(tx)} ${r2(ty)}L${r2(p1x)} ${r2(p1y)}L${r2(p2x)} ${r2(p2y)}Z`,
  };
}

/** The bipolar skeleton: base bar at x = −16, two diagonals out to the pins. */
const BJT_BODY: readonly SymbolShape[] = [
  { paint: "stroke", d: "M-40 0H-16" },
  { paint: "thick", d: "M-16 -20V20" },
  { paint: "stroke", d: "M-16 -10L0 -26V-40" },
  { paint: "stroke", d: "M-16 10L0 26V40" },
];

/** The MOS skeleton, minus the channel, which is what tells the four kinds apart. */
const MOS_BODY: readonly SymbolShape[] = [
  { paint: "stroke", d: "M-40 0H-24" },
  { paint: "stroke", d: "M-24 -18V18" },
  { paint: "stroke", d: "M-14 -13H0V-40" },
  { paint: "stroke", d: "M-14 13H0V40" },
  { paint: "stroke", d: "M-14 0H0V13" },
];

/** Enhancement: the channel is interrupted. Depletion: it is one solid bar. */
const CHANNEL_ENHANCEMENT: SymbolShape = {
  paint: "stroke",
  d: "M-14 -18V-8M-14 -4V4M-14 8V18",
};
const CHANNEL_DEPLETION: SymbolShape = { paint: "thick", d: "M-14 -18V18" };

/** The bulk arrow: inward for an N channel, outward for a P channel. */
const BULK_N = arrowhead([0, 0], [-14, 0], 0.85, 7);
const BULK_P = arrowhead([-14, 0], [0, 0], 0.85, 7);

const DIODE_LEADS: SymbolShape = { paint: "stroke", d: "M-40 0H-12M12 0H40" };
const DIODE_TRIANGLE: SymbolShape = { paint: "solid", d: "M-12 -12L12 0L-12 12Z" };

export const SYMBOLS: Readonly<Record<ComponentKind, SymbolSpec>> = {
  R: {
    shapes: [
      { paint: "stroke", d: "M-40 0H-24M24 0H40" },
      { paint: "hollow", d: "M-24 -8H24V8H-24Z" },
    ],
    marks: [],
    viewBox: "-46 -22 92 44",
  },
  C: {
    shapes: [
      { paint: "stroke", d: "M-20 0H-5M5 0H20" },
      { paint: "thick", d: "M-5 -14V14M5 -14V14" },
    ],
    marks: [],
    viewBox: "-26 -22 52 44",
  },
  L: {
    shapes: [
      {
        paint: "stroke",
        d: "M-40 0H-30a7.5 7.5 0 0 1 15 0a7.5 7.5 0 0 1 15 0a7.5 7.5 0 0 1 15 0a7.5 7.5 0 0 1 15 0H40",
      },
    ],
    marks: [],
    viewBox: "-46 -22 92 44",
  },
  D: {
    shapes: [DIODE_LEADS, DIODE_TRIANGLE, { paint: "thick", d: "M12 -12V12" }],
    marks: [],
    viewBox: "-46 -22 92 44",
  },
  /* Schottky: the cathode bar with an S of square hooks. */
  DS: {
    shapes: [DIODE_LEADS, DIODE_TRIANGLE, { paint: "stroke", d: "M19 -6V-12H12V12H5V6" }],
    marks: [],
    viewBox: "-46 -22 92 44",
  },
  /* Zener: the cathode bar bent into a Z. */
  DZ: {
    shapes: [DIODE_LEADS, DIODE_TRIANGLE, { paint: "stroke", d: "M5 -12H12V12H19" }],
    marks: [],
    viewBox: "-46 -22 92 44",
  },
  NPN: {
    shapes: [...BJT_BODY, arrowhead([-16, 10], [0, 26], 0.74)],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  PNP: {
    shapes: [...BJT_BODY, arrowhead([0, 26], [-16, 10], 0.74)],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  NMOS: {
    shapes: [...MOS_BODY, CHANNEL_ENHANCEMENT, BULK_N],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  PMOS: {
    shapes: [...MOS_BODY, CHANNEL_ENHANCEMENT, BULK_P],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  NMOSD: {
    shapes: [...MOS_BODY, CHANNEL_DEPLETION, BULK_N],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  PMOSD: {
    shapes: [...MOS_BODY, CHANNEL_DEPLETION, BULK_P],
    marks: [],
    viewBox: "-46 -46 92 92",
  },
  OPAMP: {
    shapes: [
      { paint: "stroke", d: "M-40 -20H-25M-40 20H-25M30 0H40" },
      { paint: "hollow", d: "M-25 -35V35L30 0Z" },
    ],
    marks: [
      { x: -17, y: -20, sign: "-" },
      { x: -17, y: 20, sign: "+" },
    ],
    viewBox: "-46 -42 92 84",
  },
  GND: {
    shapes: [{ paint: "stroke", d: "M0 0V16M-12 16H12M-7 21H7M-2.5 26H2.5" }],
    marks: [],
    viewBox: "-20 -6 40 40",
  },
  VCC: {
    shapes: [{ paint: "stroke", d: "M0 0V-24M-12 -24H12" }],
    marks: [],
    viewBox: "-20 -30 40 40",
  },
  VEE: {
    shapes: [{ paint: "stroke", d: "M0 0V24M-12 24H12" }],
    marks: [],
    viewBox: "-20 -6 40 40",
  },
};

/** Every kind has a drawing. Guards a kind added to the library and nowhere else. */
export function symbolOf(kind: ComponentKind): SymbolSpec {
  return SYMBOLS[kind];
}

/** The library's English label, for a tooltip and for the default strings. */
export const kindLabel = (kind: ComponentKind): string => LIBRARY[kind].label;

// ---------------------------------------------------------------------------
// Toolbar icons
// ---------------------------------------------------------------------------

/** A circle as a path, so an icon is one uniform list of `d` strings. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

/**
 * The toolbar's icons, on a 16 × 16 box, stroked in `currentColor`. They are
 * hand-drawn because a question-type package may not add a dependency, and
 * `lucide-react` lives in the app.
 */
export const TOOL_ICONS: Readonly<Record<string, readonly string[]>> = {
  select: ["M3 2l9 5.2-4 1-2 4.3z"],
  wire: ["M4.6 12H8V4h3.4", circle(3, 12, 1.5), circle(13, 4, 1.5)],
  rotate: ["M13.4 8a5.4 5.4 0 1 1-2-4.2", "M13.8 1.6v3.4h-3.4"],
  mirrorH: ["M8 1.8v12.4", "M6.2 4.6L2.6 8l3.6 3.4z", "M9.8 4.6L13.4 8l-3.6 3.4z"],
  mirrorV: ["M1.8 8h12.4", "M4.6 6.2L8 2.6l3.4 3.6z", "M4.6 9.8L8 13.4l3.4-3.6z"],
  duplicate: ["M6 6h7.2v7.2H6z", "M10.4 3.4H2.8v7.2"],
  remove: ["M2.8 4.4h10.4", "M6.4 4.4V2.8h3.2v1.6", "M4.3 4.4l.7 8.8h6l.7-8.8"],
  undo: ["M5.6 3.6L2.2 7l3.4 3.4", "M2.2 7h7.4a3.6 3.6 0 0 1 0 7.2H6.4"],
  redo: ["M10.4 3.6L13.8 7l-3.4 3.4", "M13.8 7H6.4a3.6 3.6 0 0 0 0 7.2h3.2"],
  fit: ["M2.4 6V2.4H6", "M10 2.4h3.6V6", "M13.6 10v3.6H10", "M6 13.6H2.4V10"],
} as const;
