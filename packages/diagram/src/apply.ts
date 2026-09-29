/**
 * A parsed text becomes a scene. The text says WHAT the diagram holds, the
 * scene also says WHERE: an element keeps its place when its type and its
 * name match an element of the previous scene, a link its elbows when its
 * ends and its type match. What is new is placed below what exists — or,
 * for the kinds read along their links (state machine, flowchart, graph,
 * automaton), under (or right of) the element that leads to it — and steps
 * aside until it overlaps nothing.
 */
import type { Parsed, ParsedNode } from "./codecs/parsed.js";
import { GRID, holds, rectOf, snap, type Measure, type Rect } from "./geometry.js";
import { CONTAINERS, DEFAULT_SIZE, KINDS, type DiagramKind } from "./kinds.js";
import { newId, type DiagramLink, type DiagramNode, type Scene } from "./scene.js";

const FIELDS = ["stereo", "abstract", "body", "accept", "initial"] as const;

export function applyParsed(previous: Scene, parsed: Parsed, kind: DiagramKind, measure: Measure): Scene {
  const old = new Map<string, DiagramNode>(previous.nodes.map((n) => [`${n.t}|${n.name ?? ""}`, n]));
  const made = new Map<ParsedNode, DiagramNode>();
  const fresh: ParsedNode[] = [];
  const nodes = parsed.nodes.map((p) => {
    const key: string = `${p.t}|${p.name}`;
    const was = old.get(key);
    const size = DEFAULT_SIZE[p.t];
    const n: DiagramNode = was
      ? { ...was }
      : { id: newId(), t: p.t, x: 0, y: 0, name: p.name, ...(size ? { w: size[0], h: size[1] } : {}) };
    if (was) old.delete(key);
    else fresh.push(p);
    for (const f of FIELDS) if (p[f] !== undefined) (n as Record<string, unknown>)[f] = p[f];
    made.set(p, n);
    return n;
  });

  const oldLinks = new Map<string, DiagramLink>(previous.links.map((l) => [`${l.a}|${l.b}|${l.type}`, l]));
  const links = parsed.links.map((p): DiagramLink => {
    const a = made.get(p.a)?.id ?? "";
    const b = made.get(p.b)?.id ?? "";
    const key: string = `${a}|${b}|${p.type}`;
    const was = oldLinks.get(key);
    oldLinks.delete(key);
    return {
      id: was?.id ?? newId(),
      type: p.type,
      a,
      b,
      ...(was?.via?.length ? { via: was.via } : {}),
      ...(p.name ? { name: p.name } : {}),
      ...(p.ma ? { ma: p.ma } : {}),
      ...(p.mb ? { mb: p.mb } : {}),
    };
  });

  const scene: Scene = { nodes, links };
  if (fresh.length > 0) {
    const place = KINDS[kind].place;
    if (place === "row") placeInRows(scene, fresh, made, measure);
    else placeAlongLinks(scene, new Set(fresh.map((p) => made.get(p) as DiagramNode)), place === "right", measure);
  }
  return scene;
}

/** New elements in rows under everything; the members of a boundary stack inside it, and it grows. */
function placeInRows(scene: Scene, fresh: readonly ParsedNode[], made: ReadonlyMap<ParsedNode, DiagramNode>, measure: Measure): void {
  const freshNodes = new Set(fresh.map((p) => made.get(p)));
  const placed = scene.nodes.filter((n) => !freshNodes.has(n)).map((n) => rectOf(n, measure));
  const x0 = placed.length > 0 ? Math.min(...placed.map((r) => r.x0)) : 40;
  let x = x0;
  let y = placed.length > 0 ? Math.max(...placed.map((r) => r.y1)) + 60 : 40;
  let rowHeight = 0;
  const members = new Map<DiagramNode, DiagramNode[]>();
  for (const p of fresh) {
    const n = made.get(p);
    if (!n) continue;
    const sys = p.sys ? made.get(p.sys) : undefined;
    if (sys) {
      members.set(sys, [...(members.get(sys) ?? []), n]);
      continue;
    }
    const r = rectOf(n, measure);
    n.x = snap(x);
    n.y = snap(y);
    x += r.w + 40;
    rowHeight = Math.max(rowHeight, r.h);
    if (x > x0 + 880) {
      x = x0;
      y += rowHeight + 60;
      rowHeight = 0;
    }
  }
  for (const [sys, list] of members) {
    const outer = rectOf(sys, measure);
    const inside = scene.nodes.filter((n) => !CONTAINERS.has(n.t) && !freshNodes.has(n) && holds(outer, rectOf(n, measure)));
    /* 40 apart, never 20: two boxes one cell apart leave no free row for a line to leave by */
    let yy = inside.length > 0 ? Math.max(...inside.map((n) => rectOf(n, measure).y1)) + 40 : sys.y + 40;
    let maxX = outer.x1;
    let maxY = outer.y1;
    for (const n of list) {
      const r = rectOf(n, measure);
      n.x = sys.x + 40;
      n.y = snap(yy);
      yy += r.h + 40;
      maxX = Math.max(maxX, n.x + r.w + 40);
      maxY = Math.max(maxY, n.y + r.h + 40);
    }
    sys.w = Math.ceil((maxX - sys.x) / GRID) * GRID;
    sys.h = Math.ceil((maxY - sys.y) / GRID) * GRID;
  }
}

/** A new element 40 under (or 80 right of) the element that leads to it, stepped aside until it is free. */
function placeAlongLinks(scene: Scene, fresh: Set<DiagramNode>, right: boolean, measure: Measure): void {
  const byId = new Map(scene.nodes.map((n) => [n.id, n] as const));
  const taken: Rect[] = scene.nodes.filter((n) => !fresh.has(n)).map((n) => rectOf(n, measure));
  const free = (r: Rect): boolean =>
    taken.every((q) => r.x1 + 20 <= q.x0 || r.x0 >= q.x1 + 20 || r.y1 + 20 <= q.y0 || r.y0 >= q.y1 + 20);
  for (const n of scene.nodes) {
    if (!fresh.has(n)) continue;
    const { w, h } = rectOf(n, measure);
    const src = scene.links.map((l) => (l.b === n.id ? byId.get(l.a) : undefined)).find((a) => a && !fresh.has(a));
    let cx = 400;
    let y = 40;
    if (src) {
      const r = rectOf(src, measure);
      cx = right ? r.x1 + 80 + w / 2 : (r.x0 + r.x1) / 2;
      y = right ? snap((r.y0 + r.y1 - h) / 2) : r.y1 + 40;
    } else if (taken.length > 0) {
      cx = (Math.min(...taken.map((r) => r.x0)) + Math.max(...taken.map((r) => r.x1))) / 2;
      y = Math.max(...taken.map((r) => r.y1)) + 40;
    }
    let x = snap(cx - w / 2);
    for (let k = 0; k < 40 && !free({ x0: x, y0: y, x1: x + w, y1: y + h, w, h }); k += 1) {
      if (right) y += 80;
      else x += 160;
    }
    n.x = x;
    n.y = snap(y);
    taken.push(rectOf(n, measure));
    fresh.delete(n);
  }
}
