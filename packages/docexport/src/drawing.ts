/**
 * The drawing model (ADR-126 §1–§2): a figure of the document tree, closed
 * like the tree itself. A canvas question type (diagram, circuit, logic,
 * blocks) describes its figure as a {@link Drawing} from its model, through a
 * pure serializer of its own; never target-format markup. {@link toSvg} is the
 * one place that writes SVG from it, under the rules of ADR-126 §2: literal
 * colours, one embedded font, text XML-escaped, no `class`, `style`, link,
 * image or foreign object, a path's data checked against its grammar, every
 * number finite and bounded, transforms included, and size caps — past one,
 * no SVG: the document prints the block's alt text instead.
 *
 * Coordinates are the producer's own units, mapped by `viewBox`; the scale on
 * paper is the renderer's (`printedWidthMm` of the Typst renderer).
 */

/**
 * The only colours a drawing has, printed in black and greys: `ink` (black),
 * `grey` (a starter, a secondary line), `faint` (a light fill, a hint) and
 * `paper` (white, to mask). `none` draws nothing.
 */
export type Paint = "none" | "ink" | "grey" | "faint" | "paper";

/** An affine transform `[a, b, c, d, e, f]`, as SVG's `matrix(a b c d e f)`. */
export type Matrix = readonly [number, number, number, number, number, number];

/** How a shape is painted. Absent: a 1-unit `ink` stroke and no fill (`fill: "none"`). */
export interface Paints {
  stroke?: Paint;
  fill?: Paint;
  /** The stroke's width, in drawing units. */
  width?: number;
  /** Dash and gap lengths, in drawing units. */
  dash?: readonly number[];
}

export type DrawingItem =
  | ({ kind: "path"; d: string } & Paints)
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; rx?: number } & Paints)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & Paints)
  | ({ kind: "line"; x1: number; y1: number; x2: number; y2: number } & Omit<Paints, "fill">)
  | DrawingText
  /** A group: the one place for a transform and an opacity (0 to 1). */
  | { kind: "g"; transform?: Matrix; opacity?: number; items: readonly DrawingItem[] };

/**
 * One line of text, always in DejaVu Sans Mono — the one monospace font the
 * Typst binary embeds, in its four faces (ADR-126 §2). `size` is in drawing
 * units (12 when absent).
 */
export interface DrawingText {
  kind: "text";
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "middle" | "end";
  /** `alphabetic` (the default): `y` is the baseline; `middle`: `y` is the text's centre. */
  baseline?: "alphabetic" | "middle";
  size?: number;
  weight?: "normal" | "bold";
  italic?: boolean;
  /** `ink` when absent. */
  fill?: Paint;
}

export interface Drawing {
  /** `[x, y, width, height]` of the producer's coordinates; width and height positive. */
  viewBox: readonly [number, number, number, number];
  items: readonly DrawingItem[];
}

/**
 * Millimetres per drawing unit when a figure names no width: one CSS pixel
 * (ADR-126 §5). A producer that wants its figure on a frame's ruling scales
 * its units by it.
 */
export const PX_MM = 25.4 / 96;

/** The font of every text of a drawing, embedded in the Typst binary; the PDF's code font too. */
export const DRAWING_FONT = "DejaVu Sans Mono";

/** The literal colour of each paint. */
export const PAINT_COLOURS: Readonly<Record<Exclude<Paint, "none">, string>> = {
  ink: "#000000",
  grey: "#8c8c8c",
  faint: "#d2d2d2",
  paper: "#ffffff",
};

/** The caps of ADR-126 §2: past any of them the drawing is refused, and its alt text printed. */
export const DRAWING_LIMITS = {
  /** Items, every group's included. */
  items: 5000,
  /** Nested groups. */
  depth: 8,
  /** Characters of one text. */
  text: 500,
  /** Characters of one path's data. */
  path: 20_000,
  /** Characters of the whole SVG. */
  svg: 500_000,
  /**
   * The largest absolute value of any number — a path's included — and of
   * any coefficient of a composed transform; a composed transform's
   * determinant stays above its inverse.
   */
  magnitude: 1_000_000,
} as const;

/** Why {@link toSvg} refused a drawing. */
export type DrawingRefusal = "value" | "path" | "size" | "depth" | "viewBox";

export type SvgOutcome = { ok: true; svg: string } | { ok: false; reason: DrawingRefusal };

export interface SvgOptions {
  /** Every `ink` drawn `grey`: a starter under a student's drawing (ADR-126 §4). */
  greyed?: boolean;
}

/** A path's data: commands, digits, separators and exponents, nothing else. */
const PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9 .,eE+-]*$/;
/** A number of a path's data. */
const PATH_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Characters XML 1.0 refuses (lone surrogates too), dropped from a text. */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `text` as XML character data or attribute value. */
export function xmlText(text: string): string {
  return text.replace(NOT_XML, "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

class Refused extends Error {
  constructor(readonly reason: DrawingRefusal) {
    super(reason);
  }
}

const within = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= DRAWING_LIMITS.magnitude;

/** A finite number within the cap, at most three decimals. */
function num(value: number): string {
  if (!within(value)) throw new Refused("value");
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const clamp = (value: number, min: number, max: number): string => num(Math.min(max, Math.max(min, Number(num(value)))));

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer · inner`, refused when a coefficient passes the cap or the determinant falls below its inverse. */
function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer;
  const [A, B, C, D, E, F] = inner;
  const m: Matrix = [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
  if (!m.every(within) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1 / DRAWING_LIMITS.magnitude) throw new Refused("value");
  return m;
}

function paint(p: Paint, options: SvgOptions): string {
  if (p === "none") return "none";
  if (!Object.hasOwn(PAINT_COLOURS, p)) throw new Refused("value");
  return options.greyed && p === "ink" ? PAINT_COLOURS.grey : PAINT_COLOURS[p];
}

function paints(p: Paints, options: SvgOptions, fillable: boolean): string {
  const attrs = [`stroke="${paint(p.stroke ?? "ink", options)}"`, `stroke-width="${clamp(p.width ?? 1, 0, 1000)}"`];
  if (fillable) attrs.push(`fill="${paint(p.fill ?? "none", options)}"`);
  if (p.dash !== undefined) {
    if (!Array.isArray(p.dash)) throw new Refused("value");
    if (p.dash.length > 16) throw new Refused("size");
    if (p.dash.length > 0) attrs.push(`stroke-dasharray="${p.dash.map((d) => clamp(d, 0, 1000)).join(" ")}"`);
  }
  return attrs.join(" ");
}

const size = (value: number) => clamp(value, 0, DRAWING_LIMITS.magnitude);

/** One item, under the transform `ctm` its groups composed. */
function item(it: DrawingItem, options: SvgOptions, ctm: Matrix, depth: number, count: { n: number }): string {
  if (++count.n > DRAWING_LIMITS.items) throw new Refused("size");
  switch (it.kind) {
    case "path":
      if (typeof it.d !== "string" || it.d.length > DRAWING_LIMITS.path) throw new Refused("size");
      if (!PATH_DATA.test(it.d)) throw new Refused("path");
      if (!(it.d.match(PATH_NUMBER) ?? []).every((t) => within(Number(t)))) throw new Refused("value");
      return `<path d="${it.d}" ${paints(it, options, true)}/>`;
    case "rect": {
      const rx = it.rx === undefined ? "" : ` rx="${size(it.rx)}"`;
      return `<rect x="${num(it.x)}" y="${num(it.y)}" width="${size(it.w)}" height="${size(it.h)}"${rx} ${paints(it, options, true)}/>`;
    }
    case "ellipse":
      return `<ellipse cx="${num(it.cx)}" cy="${num(it.cy)}" rx="${size(it.rx)}" ry="${size(it.ry)}" ${paints(it, options, true)}/>`;
    case "line":
      return `<line x1="${num(it.x1)}" y1="${num(it.y1)}" x2="${num(it.x2)}" y2="${num(it.y2)}" ${paints(it, options, false)}/>`;
    case "text": {
      if (typeof it.text !== "string" || it.text.length > DRAWING_LIMITS.text) throw new Refused("size");
      const attrs = [
        `x="${num(it.x)}"`,
        `y="${num(it.y)}"`,
        `font-family="${DRAWING_FONT}"`,
        `font-size="${clamp(it.size ?? 12, 0.1, 1000)}"`,
        `fill="${paint(it.fill ?? "ink", options)}"`,
      ];
      if (it.anchor === "middle" || it.anchor === "end") attrs.push(`text-anchor="${it.anchor}"`);
      if (it.baseline === "middle") attrs.push('dominant-baseline="central"');
      if (it.weight === "bold") attrs.push('font-weight="bold"');
      if (it.italic === true) attrs.push('font-style="italic"');
      return `<text ${attrs.join(" ")}>${xmlText(it.text)}</text>`;
    }
    case "g": {
      if (depth >= DRAWING_LIMITS.depth) throw new Refused("depth");
      if (!Array.isArray(it.items)) throw new Refused("value");
      const attrs: string[] = [];
      let inner = ctm;
      if (it.transform !== undefined) {
        if (!Array.isArray(it.transform) || it.transform.length !== 6) throw new Refused("value");
        inner = compose(ctm, it.transform);
        attrs.push(`transform="matrix(${it.transform.map(num).join(" ")})"`);
      }
      if (it.opacity !== undefined) attrs.push(`opacity="${clamp(it.opacity, 0, 1)}"`);
      const body = it.items.map((child) => item(child, options, inner, depth + 1, count)).join("");
      return `<g${attrs.map((a) => ` ${a}`).join("")}>${body}</g>`;
    }
    default:
      // A kind outside the model (a value cast from elsewhere) is never written.
      throw new Refused("value");
  }
}

/**
 * The SVG of `drawing`, or why it is refused. Written element by element from
 * the closed model: no attribute carries producer text but a text's content,
 * XML-escaped, and a path's data, checked against its grammar.
 */
export function toSvg(drawing: Drawing, options: SvgOptions = {}): SvgOutcome {
  try {
    if (!Array.isArray(drawing.viewBox) || drawing.viewBox.length !== 4) throw new Refused("viewBox");
    const [x, y, w, h] = drawing.viewBox;
    // Three decimals are written: a smaller box would print as zero.
    if (!(w >= 0.001) || !(h >= 0.001)) throw new Refused("viewBox");
    const box = [x, y, w, h].map(num).join(" ");
    if (!Array.isArray(drawing.items)) throw new Refused("value");
    const count = { n: 0 };
    const body = drawing.items.map((it) => item(it, options, IDENTITY, 0, count)).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${num(w)}" height="${num(h)}">${body}</svg>`;
    if (svg.length > DRAWING_LIMITS.svg) throw new Refused("size");
    return { ok: true, svg };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
