/**
 * The size of every element, from its content.
 *
 * A box follows its longest line, so a size depends on how wide a text is.
 * The browser measures it with the real face (`DiagramEditor` passes a
 * canvas measurer); everywhere else — the server, the tests — the
 * {@link estimateText} estimate stands in. A size is never stored for the
 * boxes that follow their text: it is recomputed on display, like the lines.
 */
import { BODIED, CIRCLES, CONTAINERS, DEFAULT_SIZE, FLOW_NODES, INK, SHAPES } from "./kinds.js";
import type { DiagramNode } from "./scene.js";

/** The grid step, in canvas units. */
export const GRID = 20;
/** A class's or an entity's header, and one line of its body. */
export const HEAD = 40;
export const ROW = 20;
/** The padding a compartment adds under its lines. */
export const PAD = 10;
const MIN_WIDTH = 120;
/** A state machine's initial and final states: a 40 × 40 box, a disc and a ring. */
export const PSEUDO = 40;
export const INITIAL_RADIUS = 9;
export const FINAL_RADIUS = 11;

/** The faces a diagram sets its text in. */
export type Face = "name" | "italic" | "stereo" | "mono" | "label";

/** The width of a text in a face, in canvas units. */
export type Measure = (face: Face, text: string) => number;

/** Average advance per character, close to the app's sans and mono faces at the sizes used. */
const ADVANCE: Readonly<Record<Face, number>> = { name: 7.6, italic: 7.4, stereo: 6.4, mono: 7.2, label: 7.1 };

/** The measure outside a browser: a character count times an average advance. */
export const estimateText: Measure = (face, text) => [...text].length * ADVANCE[face];

export const snap = (v: number): number => Math.round(v / GRID) * GRID;
const up = (v: number, k: number): number => Math.ceil(v / k) * k;

/** A box in canvas units. */
export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface Rect extends Bounds {
  readonly w: number;
  readonly h: number;
}

export const centerOf = (r: Bounds): { x: number; y: number } => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** Whether the centre of `r` lies inside `outer`: membership of a system boundary. */
export const holds = (outer: Bounds, r: Bounds): boolean => {
  const c = centerOf(r);
  return c.x > outer.x0 && c.x < outer.x1 && c.y > outer.y0 && c.y < outer.y1;
};

/** One line of a body: its text, underlined for `{static}` (or an entity's `PK`), italic for `{abstract}`. */
export interface Member {
  readonly text: string;
  readonly underline: boolean;
  readonly italic: boolean;
}

export function member(raw: string, entity = false): Member {
  return {
    text: raw.replace(/\{(static|abstract)\}/gi, "").replace(/\s+/g, " ").trim(),
    underline: /\{static\}/i.test(raw) || (entity && /\bPK\b/.test(raw)),
    italic: /\{abstract\}/i.test(raw),
  };
}

export const isSeparator = (line: string): boolean => /^\s*-{3,}\s*$/.test(line);

/**
 * The compartments an element's body draws: a class's body cut at every
 * `---`, an entity's or a state's lines as one. No body, no compartment.
 */
export function bodyCompartments(n: DiagramNode): string[][] {
  const body = n.body ?? [];
  if (!BODIED.has(n.t) || body.length === 0) return [];
  if (n.t !== "class") return [body.filter((l) => !isSeparator(l))];
  const out: string[][] = [[]];
  for (const line of body) {
    if (isSeparator(line)) out.push([]);
    else out[out.length - 1]?.push(line);
  }
  return out;
}

/**
 * The index in `body` of the line under a height inside a class, an entity
 * or a state (the `---` between compartments count as lines of the body).
 */
export function bodyLineAt(n: DiagramNode, ly: number): number {
  let y = HEAD;
  let start = 0;
  for (const c of bodyCompartments(n)) {
    const end = y + c.length * ROW + PAD;
    if (ly < end) return start + Math.max(0, Math.min(c.length - 1, Math.floor((ly - y - PAD / 2) / ROW)));
    y = end;
    start += c.length + 1;
  }
  return Math.max(0, (n.body ?? []).length - 1);
}

/** A name wrapped to a width: use cases, actions, decisions. */
export function wrapName(name: string, max: number, measure: Measure): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && measure("label", next) > max) {
      out.push(cur);
      cur = word;
    } else cur = next;
  }
  out.push(cur);
  return out;
}

/** How wide an element wraps its name. */
export const wrapWidth = (n: DiagramNode): number => (n.t === "decision" ? 120 : n.t === "usecase" ? 150 : 200);

export function sizeOf(n: DiagramNode, measure: Measure): { w: number; h: number } {
  const name = n.name ?? "";
  const body = n.body ?? [];
  if (n.t === "actor") return { w: 40, h: 80 };
  if (n.t === "initial" || n.t === "final") return { w: PSEUDO, h: PSEUDO };
  if (CONTAINERS.has(n.t) || SHAPES.has(n.t)) {
    const [w, h] = DEFAULT_SIZE[n.t] ?? [GRID, GRID];
    return { w: n.w ?? w, h: n.h ?? h };
  }
  if (INK.has(n.t)) return { w: Math.max(n.w ?? 1, 1), h: Math.max(n.h ?? 1, 1) };
  if (CIRCLES.has(n.t)) {
    const d = Math.max(40, up(measure("label", name) + 18, GRID));
    return { w: d, h: d };
  }
  if (n.t === "state") {
    const m = Math.max(measure("label", name), ...body.map((l) => measure("mono", l)));
    return { w: Math.max(MIN_WIDTH, up(m + 32, GRID)), h: body.length > 0 ? up(HEAD + body.length * ROW + PAD, GRID) : 40 };
  }
  if (n.t === "usecase" || FLOW_NODES.has(n.t)) {
    const lines = wrapName(name, wrapWidth(n), measure);
    const m = Math.max(...lines.map((l) => measure("label", l)));
    if (n.t === "usecase") return { w: Math.max(MIN_WIDTH, up(m * 1.25 + 30, GRID)), h: Math.max(60, up(lines.length * 16 + 34, GRID)) };
    if (n.t === "terminal") return { w: Math.max(MIN_WIDTH, up(m + 44, 40)), h: 40 };
    if (n.t === "action") return { w: Math.max(MIN_WIDTH, up(m + 32, 40)), h: Math.max(40, up(lines.length * 16 + 22, GRID)) };
    return { w: Math.max(MIN_WIDTH, up(m * 1.8 + 24, 40)), h: Math.max(80, up(lines.length * 16 * 1.8 + 28, 40)) };
  }
  /* a class or an entity: a header, then compartments */
  const head = Math.max(measure(n.abstract === true ? "italic" : "name", name), n.stereo ? measure("stereo", `«${n.stereo}»`) : 0);
  const cs = bodyCompartments(n);
  const mem = Math.max(0, ...cs.flat().map((l) => measure("mono", member(l).text)));
  const w = Math.max(MIN_WIDTH, up(head + 28, GRID), up(mem + 24, GRID));
  return { w, h: up(HEAD + cs.reduce((k, c) => k + c.length * ROW + PAD, 0), GRID) };
}

export function rectOf(n: DiagramNode, measure: Measure): Rect {
  const { w, h } = sizeOf(n, measure);
  return { x0: n.x, y0: n.y, x1: n.x + w, y1: n.y + h, w, h };
}

/** The order elements are drawn in: the containers under what they contain. */
export const drawOrder = (nodes: readonly DiagramNode[]): DiagramNode[] => [
  ...nodes.filter((n) => CONTAINERS.has(n.t)),
  ...nodes.filter((n) => !CONTAINERS.has(n.t)),
];
