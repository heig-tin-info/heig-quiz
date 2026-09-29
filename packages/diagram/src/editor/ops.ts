/**
 * What the editor does to a scene, as pure functions: each takes a scene and
 * returns a new one, so the editor stays CONTROLLED (the host owns the
 * scene) and every edit is testable without a DOM.
 */
import { holds, rectOf, snap, type Measure, type Rect } from "../geometry.js";
import { DEFAULT_SIZE, INK, NAMELESS, TOOL_PRESET, typeOfTool, type PlaceTool } from "../kinds.js";
import type { Route } from "../layout.js";
import { newId, type DiagramLink, type DiagramNode, type LinkType, type NodeType, type Point, type Scene } from "../scene.js";

type XY = readonly [number, number];

/** What the pointer is over: an element, and whether on its border band. */
export interface Hit {
  readonly id: string;
  readonly edge: boolean;
}

/** Whether a point is within `d` of a stroke or a line. */
export function nearInk(n: DiagramNode, x: number, y: number, d: number): boolean {
  const p = n.pts ?? [];
  for (let i = 0; i < p.length - 1; i += 1) {
    const [ax, ay] = [n.x + (p[i]?.[0] ?? 0), n.y + (p[i]?.[1] ?? 0)];
    const [bx, by] = [n.x + (p[i + 1]?.[0] ?? 0), n.y + (p[i + 1]?.[1] ?? 0)];
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
    if (Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y) <= d) return true;
  }
  return false;
}

/**
 * The element under a point, topmost first. A system boundary is reached
 * only by its title strip or its frame, so what it contains stays
 * clickable; `withSystems: false` ignores it (a link never ends on one).
 */
export function elementAt(scene: Scene, rects: ReadonlyMap<string, Rect>, x: number, y: number, band: number, withSystems = true): Hit | null {
  const inBox = (r: Rect, pad: number): boolean => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
  const inner = (r: Rect): boolean => x > r.x0 + band && x < r.x1 - band && y > r.y0 + band && y < r.y1 - band;
  for (let i = scene.nodes.length - 1; i >= 0; i -= 1) {
    const n = scene.nodes[i] as DiagramNode;
    if (n.t === "system") continue;
    if (INK.has(n.t)) {
      if (nearInk(n, x, y, band + 2)) return { id: n.id, edge: false };
      continue;
    }
    const r = rects.get(n.id);
    if (r && inBox(r, band)) return { id: n.id, edge: !inner(r) };
  }
  if (withSystems)
    for (let i = scene.nodes.length - 1; i >= 0; i -= 1) {
      const n = scene.nodes[i] as DiagramNode;
      const r = n.t === "system" ? rects.get(n.id) : undefined;
      if (!r || !inBox(r, band)) continue;
      const title = y >= r.y0 && y <= r.y0 + 28;
      if (!inner(r) || title) return { id: n.id, edge: false };
    }
  return null;
}

/** The words a new element's name starts with, in the user's language. */
export interface NewNames {
  readonly class: string;
  readonly actor: string;
  readonly usecase: string;
  readonly system: string;
  readonly state: string;
  readonly entity: string;
  readonly start: string;
  readonly end: string;
  readonly action: string;
  readonly decision: string;
}

/** The name a new element gets: q0, q1… for an automaton, A, B… for a graph, Class1… elsewhere. */
export function nextName(scene: Scene, t: NodeType, words: NewNames): string {
  const names = new Set(scene.nodes.map((n) => n.name ?? ""));
  if (t === "terminal") return names.has(words.start) ? words.end : words.start;
  if (t === "astate") {
    let i = 0;
    while (names.has(`q${i}`)) i += 1;
    return `q${i}`;
  }
  if (t === "vertex") {
    const letter = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((c) => !names.has(c));
    if (letter) return letter;
  }
  const prefix = t in words ? words[t as keyof NewNames] : t === "vertex" ? "V" : "";
  if (!prefix || NAMELESS.has(t)) return "";
  let i = 1;
  while (names.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

/**
 * A new element for a tool, centred on a point: a class starts with two
 * empty compartments, an entity with an identifier, the first automaton
 * state is the initial one, a shape starts nameless.
 */
export function newElement(scene: Scene, tool: PlaceTool, at: Point, measure: Measure, words: NewNames): DiagramNode {
  const t = typeOfTool(tool);
  const size = DEFAULT_SIZE[t];
  const n: DiagramNode = {
    id: newId(),
    t,
    x: 0,
    y: 0,
    ...(tool === "accept" ? TOOL_PRESET.accept : {}),
    ...(size ? { w: size[0], h: size[1] } : {}),
  };
  const name = t === "system" || !size ? nextName(scene, t, words) : "";
  if (name) n.name = name;
  if (t === "class") n.body = ["---"];
  if (t === "entity") n.body = ["id : int PK"];
  if (t === "astate" && !scene.nodes.some((x) => x.initial)) n.initial = true;
  const { w, h } = rectOf(n, measure);
  n.x = snap(at.x - w / 2);
  n.y = snap(at.y - h / 2);
  return n;
}

/** A stroke or a line from points in canvas units: its box at the top left, its points relative to it. */
export function inkElement(t: "stroke" | "line", pts: readonly XY[]): DiagramNode {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  return {
    id: newId(),
    t,
    x,
    y,
    w: Math.max(1, Math.ceil(Math.max(...xs)) - x),
    h: Math.max(1, Math.ceil(Math.max(...ys)) - y),
    pts: pts.map((q): [number, number] => [Math.round(q[0] - x), Math.round(q[1] - y)]),
  };
}

export function addLink(scene: Scene, type: LinkType, a: string, b: string, via: readonly Point[]): { scene: Scene; id: string } {
  const id = newId();
  const crow = type === "erel";
  const link: DiagramLink = { id, type, a, b, ...(via.length > 0 ? { via: [...via] } : {}), ...(crow ? { ma: "1", mb: "0..*" } : {}) };
  return { scene: { ...scene, links: [...scene.links, link] }, id };
}

/** The elements a move carries: the selected ones, and what a selected boundary holds. */
export function carried(scene: Scene, selection: ReadonlySet<string>, measure: Measure): Set<string> {
  const ids = new Set(scene.nodes.filter((n) => selection.has(n.id)).map((n) => n.id));
  for (const s of scene.nodes) {
    if (s.t !== "system" || !ids.has(s.id)) continue;
    const outer = rectOf(s, measure);
    for (const n of scene.nodes) if (n.t !== "system" && holds(outer, rectOf(n, measure))) ids.add(n.id);
  }
  return ids;
}

/** Moves elements by (dx, dy), with the elbows of the links they carry whole. */
export function moveBy(scene: Scene, ids: ReadonlySet<string>, selection: ReadonlySet<string>, dx: number, dy: number): Scene {
  if (dx === 0 && dy === 0) return scene;
  return {
    nodes: scene.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    links: scene.links.map((l) =>
      l.via && (selection.has(l.id) || (ids.has(l.a) && ids.has(l.b))) ? { ...l, via: l.via.map((v) => ({ x: v.x + dx, y: v.y + dy })) } : l,
    ),
  };
}

/** Deletes the selection, with every link that touched a deleted element. */
export function removeSelection(scene: Scene, selection: ReadonlySet<string>): Scene {
  return {
    nodes: scene.nodes.filter((n) => !selection.has(n.id)),
    links: scene.links.filter((l) => !selection.has(l.id) && !selection.has(l.a) && !selection.has(l.b)),
  };
}

/** Copies of the selected elements 40 away, with the links between them; returns the copies' ids. */
export function duplicateSelection(scene: Scene, selection: ReadonlySet<string>): { scene: Scene; ids: Set<string> } {
  const map = new Map<string, string>();
  const nodes = scene.nodes.filter((n) => selection.has(n.id)).map((n) => {
    const id = newId();
    map.set(n.id, id);
    return { ...structuredClone(n), id, x: n.x + 40, y: n.y + 40 };
  });
  const links = scene.links
    .filter((l) => map.has(l.a) && map.has(l.b))
    .map((l) => ({
      ...structuredClone(l),
      id: newId(),
      a: map.get(l.a) as string,
      b: map.get(l.b) as string,
      ...(l.via ? { via: l.via.map((v) => ({ x: v.x + 40, y: v.y + 40 })) } : {}),
    }));
  return { scene: { nodes: [...scene.nodes, ...nodes], links: [...scene.links, ...links] }, ids: new Set([...nodes, ...links].map((x) => x.id)) };
}

/** Reverses the selected links: ends, end labels and elbows. */
export function reverseSelection(scene: Scene, selection: ReadonlySet<string>): Scene {
  return {
    ...scene,
    links: scene.links.map((l) => {
      if (!selection.has(l.id)) return l;
      const { ma, mb, via, ...rest } = l;
      return { ...rest, a: l.b, b: l.a, ...(mb ? { ma: mb } : {}), ...(ma ? { mb: ma } : {}), ...(via ? { via: [...via].reverse() } : {}) };
    }),
  };
}

/** Where a point falls along a polyline, as a distance from its start. */
function along(pts: readonly XY[], p: Point): number {
  let acc = 0;
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, ay] = pts[i] as XY;
    const [bx, by] = pts[i + 1] as XY;
    const len = Math.hypot(bx - ax, by - ay);
    const t = len ? Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / (len * len))) : 0;
    const d = Math.hypot(ax + t * (bx - ax) - p.x, ay + t * (by - ay) - p.y);
    if (d < best) {
      best = d;
      at = acc + t * len;
    }
    acc += len;
  }
  return at;
}

/** An elbow where the line was double-clicked, in its place among the others. */
export function insertElbow(scene: Scene, linkId: string, route: Route, p: Point): Scene {
  return {
    ...scene,
    links: scene.links.map((l) => {
      if (l.id !== linkId) return l;
      const via = l.via ?? [];
      const pos = along(route.pts, p);
      const i = via.filter((v) => along(route.pts, v) < pos).length;
      return { ...l, via: [...via.slice(0, i), p, ...via.slice(i)] };
    }),
  };
}

export function removeElbow(scene: Scene, linkId: string, index: number): Scene {
  return {
    ...scene,
    links: scene.links.map((l) => {
      if (l.id !== linkId || !l.via) return l;
      const via = l.via.filter((_, i) => i !== index);
      const { via: _, ...rest } = l;
      return via.length > 0 ? { ...rest, via } : rest;
    }),
  };
}

/** What a rubber band selects: the elements it touches (a boundary only whole), the lines it holds. */
export function inBand(scene: Scene, rects: ReadonlyMap<string, Rect>, routes: ReadonlyMap<string, Route>, band: Rect): Set<string> {
  const out = new Set<string>();
  for (const n of scene.nodes) {
    const r = rects.get(n.id);
    if (!r) continue;
    const hit =
      n.t === "system"
        ? r.x0 >= band.x0 && r.x1 <= band.x1 && r.y0 >= band.y0 && r.y1 <= band.y1
        : r.x1 >= band.x0 && r.x0 <= band.x1 && r.y1 >= band.y0 && r.y0 <= band.y1;
    if (hit) out.add(n.id);
  }
  for (const [id, route] of routes) if (route.pts.every(([x, y]) => x >= band.x0 && x <= band.x1 && y >= band.y0 && y <= band.y1)) out.add(id);
  return out;
}

/** Replaces one element or link, by id. */
export function patchItem(scene: Scene, id: string, patch: Partial<DiagramNode> & Partial<DiagramLink>): Scene {
  return {
    nodes: scene.nodes.map((n) => (n.id === id ? dropEmpty({ ...n, ...patch } as DiagramNode) : n)),
    links: scene.links.map((l) => (l.id === id ? dropEmpty({ ...l, ...patch } as DiagramLink) : l)),
  };
}

/** Optional fields left empty are absent, so an answer stays small and `sameScene` stays exact. */
function dropEmpty<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)),
  ) as T;
}

/** Only one initial automaton state: setting one clears the others. */
export function setInitial(scene: Scene, id: string, on: boolean): Scene {
  return {
    ...scene,
    nodes: scene.nodes.map((n) => {
      if (n.id === id) return on ? { ...n, initial: true } : dropEmpty({ ...n, initial: false });
      return on && n.initial ? dropEmpty({ ...n, initial: false }) : n;
    }),
  };
}
