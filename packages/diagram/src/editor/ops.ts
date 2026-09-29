/**
 * What the editor does to a scene, as pure functions: each takes a scene and
 * returns a new one, so the editor stays CONTROLLED (the host owns the
 * scene) and every edit is testable without a DOM.
 *
 * An edit that would break a limit of the schema returns the scene
 * unchanged: the answer schema would refuse it at the next autosave, and a
 * student must never lose work to a refusal they could not see coming. The
 * editor's `commit` is the guarantee (it drops any edit that makes a valid
 * scene invalid); the guards here are what lets the editor know before it
 * acts — not select a copy that was not made, not focus an element that
 * was not placed.
 */
import { holds, rectOf, snap, type Bounds, type Measure, type Rect } from "../geometry.js";
import { CONTAINERS, DEFAULT_SIZE, INK, KINDS, NAMELESS, SQUARE, TOOL_PRESET, minSize, typeOfTool, type DiagramKind, type PlaceTool } from "../kinds.js";
import type { Route } from "../layout.js";
import {
  MAX_INK_POINTS,
  MAX_LINKS,
  MAX_VIA,
  newId,
  type DiagramLink,
  type DiagramNode,
  type LinkType,
  type NodeType,
  type Point,
  type Scene,
} from "../scene.js";
import type { DiagramStrings } from "./strings.js";

type XY = readonly [number, number];

/** What the pointer is over: an element, and whether on its border band. */
export interface Hit {
  readonly id: string;
  readonly edge: boolean;
}

/** Whether a point is within `d` of a stroke or a line. */
function nearInk(n: DiagramNode, x: number, y: number, d: number): boolean {
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
    if (CONTAINERS.has(n.t)) continue;
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
      const r = CONTAINERS.has(n.t) ? rects.get(n.id) : undefined;
      if (!r || !inBox(r, band)) continue;
      const title = y >= r.y0 && y <= r.y0 + 28;
      if (!inner(r) || title) return { id: n.id, edge: false };
    }
  return null;
}

/** The name a new element gets: q0, q1… for an automaton, A, B… for a graph, Class1… elsewhere. */
export function nextName(scene: Scene, t: NodeType, s: DiagramStrings): string {
  const names = new Set(scene.nodes.map((n) => n.name ?? ""));
  if (t === "terminal") return names.has(s["new.start"]) ? s["new.end"] : s["new.start"];
  if (t === "astate") {
    let i = 0;
    while (names.has(`q${i}`)) i += 1;
    return `q${i}`;
  }
  if (t === "vertex") return [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((c) => !names.has(c)) ?? numbered(names, "V");
  const key = `new.${t}`;
  return !NAMELESS.has(t) && key in s ? numbered(names, s[key as keyof DiagramStrings]) : "";
}

function numbered(names: ReadonlySet<string>, prefix: string): string {
  let i = 1;
  while (names.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

/** Whether a kind's scene still has room for one more element. */
export const hasRoom = (scene: Scene, kind: DiagramKind): boolean => scene.nodes.length < KINDS[kind].maxNodes;

/**
 * A new element for a tool, centred on a point: a class starts with two
 * empty compartments, an entity with an identifier, the first automaton
 * state is the initial one, a shape starts nameless.
 */
export function newElement(scene: Scene, tool: PlaceTool, at: Point, measure: Measure, s: DiagramStrings): DiagramNode {
  const t = typeOfTool(tool);
  const size = DEFAULT_SIZE[t];
  const n: DiagramNode = {
    id: newId(),
    t,
    x: 0,
    y: 0,
    ...(tool in TOOL_PRESET ? TOOL_PRESET[tool as keyof typeof TOOL_PRESET] : {}),
    ...(size ? { w: size[0], h: size[1] } : {}),
  };
  const name = CONTAINERS.has(t) || !size ? nextName(scene, t, s) : "";
  if (name) n.name = name;
  if (t === "class") n.body = ["---"];
  if (t === "entity") n.body = ["id : int PK"];
  if (t === "astate" && !scene.nodes.some((x) => x.initial)) n.initial = true;
  const { w, h } = rectOf(n, measure);
  n.x = snap(at.x - w / 2);
  n.y = snap(at.y - h / 2);
  return n;
}

/** Adds an element when the kind has room for it. */
export const addElement = (scene: Scene, kind: DiagramKind, n: DiagramNode): Scene =>
  hasRoom(scene, kind) ? { ...scene, nodes: [...scene.nodes, n] } : scene;

/** A stroke or a line from points in canvas units, added when the scene has room for its points. */
export function addInk(scene: Scene, kind: DiagramKind, t: "stroke" | "line", pts: readonly XY[]): Scene {
  const ink = scene.nodes.reduce((k, n) => k + (n.pts?.length ?? 0), 0);
  const first = pts[0];
  const last = pts[pts.length - 1];
  /* a click without a drag draws nothing */
  const drawn = first && last && (Math.hypot(last[0] - first[0], last[1] - first[1]) > 4 || pts.length > 3);
  if (!drawn || ink + pts.length > MAX_INK_POINTS) return scene;
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  return addElement(scene, kind, {
    id: newId(),
    t,
    x,
    y,
    w: Math.max(1, Math.ceil(Math.max(...xs)) - x),
    h: Math.max(1, Math.ceil(Math.max(...ys)) - y),
    pts: pts.map((q): [number, number] => [Math.round(q[0] - x), Math.round(q[1] - y)]),
  });
}

/** A new link, with a crow's-foot default for an entity-relationship; `null` past the limit. */
export function addLink(scene: Scene, type: LinkType, a: string, b: string, via: readonly Point[]): { scene: Scene; id: string } | null {
  if (scene.links.length >= MAX_LINKS) return null;
  const id = newId();
  const link: DiagramLink = {
    id,
    type,
    a,
    b,
    ...(via.length > 0 ? { via: via.slice(0, MAX_VIA) } : {}),
    ...(type === "erel" ? { ma: "1", mb: "0..*" } : {}),
  };
  return { scene: { ...scene, links: [...scene.links, link] }, id };
}

/** The elements a move carries: the selected ones, and what a selected boundary holds. */
export function carried(scene: Scene, selection: ReadonlySet<string>, measure: Measure): Set<string> {
  const ids = new Set(scene.nodes.filter((n) => selection.has(n.id)).map((n) => n.id));
  for (const s of scene.nodes) {
    if (!CONTAINERS.has(s.t) || !ids.has(s.id)) continue;
    const outer = rectOf(s, measure);
    for (const n of scene.nodes) if (!CONTAINERS.has(n.t) && holds(outer, rectOf(n, measure))) ids.add(n.id);
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

/** A resizable element's bottom right corner dragged to a point; a square or a circle keeps its aspect. */
export function resizeTo(scene: Scene, id: string, to: Point): Scene {
  const n = scene.nodes.find((x) => x.id === id);
  if (!n) return scene;
  const [minW, minH] = minSize(n.t);
  let w = Math.max(minW, to.x - n.x);
  let h = Math.max(minH, to.y - n.y);
  if (SQUARE.has(n.t)) w = h = Math.max(w, h);
  return patchItem(scene, id, { w, h });
}

/** Deletes the selection, with every link that touched a deleted element. */
export function removeSelection(scene: Scene, selection: ReadonlySet<string>): Scene {
  return {
    nodes: scene.nodes.filter((n) => !selection.has(n.id)),
    links: scene.links.filter((l) => !selection.has(l.id) && !selection.has(l.a) && !selection.has(l.b)),
  };
}

/** Copies of the selected elements 40 away, with the links between them, when the kind has room. */
export function duplicateSelection(scene: Scene, kind: DiagramKind, selection: ReadonlySet<string>): { scene: Scene; ids: Set<string> } | null {
  const picked = scene.nodes.filter((n) => selection.has(n.id));
  const between = scene.links.filter((l) => selection.has(l.a) && selection.has(l.b));
  if (picked.length === 0 || scene.nodes.length + picked.length > KINDS[kind].maxNodes || scene.links.length + between.length > MAX_LINKS) return null;
  const map = new Map(picked.map((n) => [n.id, newId()] as const));
  const nodes = picked.map((n) => ({ ...structuredClone(n), id: map.get(n.id) as string, x: n.x + 40, y: n.y + 40 }));
  const links = between.map((l) => ({
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

/** An elbow where the line was double-clicked, in its place among the others, up to the limit. */
export function insertElbow(scene: Scene, linkId: string, route: Route, p: Point): Scene {
  return {
    ...scene,
    links: scene.links.map((l) => {
      const via = l.via ?? [];
      if (l.id !== linkId || via.length >= MAX_VIA) return l;
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

/** An elbow moved to a point. */
export function moveElbow(scene: Scene, linkId: string, index: number, p: Point): Scene {
  return {
    ...scene,
    links: scene.links.map((l) => (l.id === linkId && l.via ? { ...l, via: l.via.map((v, i) => (i === index ? p : v)) } : l)),
  };
}

/** What a rubber band selects: the elements it touches (a boundary only whole), the lines it holds. */
export function inBand(scene: Scene, rects: ReadonlyMap<string, Rect>, routes: ReadonlyMap<string, Route>, band: Bounds): Set<string> {
  const out = new Set<string>();
  for (const n of scene.nodes) {
    const r = rects.get(n.id);
    if (!r) continue;
    const hit =
      CONTAINERS.has(n.t)
        ? r.x0 >= band.x0 && r.x1 <= band.x1 && r.y0 >= band.y0 && r.y1 <= band.y1
        : r.x1 >= band.x0 && r.x0 <= band.x1 && r.y1 >= band.y0 && r.y0 <= band.y1;
    if (hit) out.add(n.id);
  }
  for (const [id, route] of routes) if (route.pts.every(([x, y]) => x >= band.x0 && x <= band.x1 && y >= band.y0 && y <= band.y1)) out.add(id);
  return out;
}

/** Replaces fields of one element or link, by id; an emptied optional field is dropped. */
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
      if (n.id === id) return dropEmpty({ ...n, initial: on });
      return on && n.initial ? dropEmpty({ ...n, initial: false }) : n;
    }),
  };
}

/** The status line's hint for what the editor is doing. */
export function hintFor(state: {
  mode: "select" | "place" | "link";
  tool: PlaceTool | null;
  drawing: boolean;
  selected: number;
  kind: DiagramKind;
}): keyof DiagramStrings {
  if (state.mode === "place") return state.tool && INK.has(typeOfTool(state.tool)) ? "hintInk" : "hintPlace";
  if (state.drawing) return "hintDrawing";
  if (state.mode === "link") return "hintLink";
  if (state.selected > 0) return "hintSelected";
  return KINDS[state.kind].dbl ? "hintSelect" : "hintSelectFree";
}
