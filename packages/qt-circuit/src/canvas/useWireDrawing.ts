/**
 * The wire tool: the wire being drawn, click by click.
 *
 * A wire starts on a pin, a port or an existing wire (where it makes a
 * junction), collects up to sixteen waypoints in open space, and ends on a
 * pin, a port, an existing wire, or a second click on its last corner (a free
 * end). The router lays orthogonal segments through the ends and waypoints,
 * around the components: the draft under the cursor is routed exactly the way
 * the finished wire will be stored.
 *
 * Hooks, in order: useState draft, useCallback finishWire, useCallback
 * wireClick, useCallback cancelStep, useCallback wireUnder, useMemo
 * draftPoints.
 */
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { ComponentKind } from "../library.js";
import type { Schematic, SchematicComponent, Wire, WireEnd } from "../schema.js";

import {
  clampPoint,
  nextId,
  pinPosition,
  portPosition,
  resolveEnd,
  sameEnd,
  type PinPoint,
  type PinTarget,
} from "./geometry.js";
import { onPolyline, route, type Obstacles } from "./router.js";

type Point = { x: number; y: number };
type Mode = "select" | "wire" | "place";

/** The wire being drawn: where it started, and the corners clicked since. */
export interface Draft {
  readonly a: WireEnd;
  readonly via: ReadonlyArray<Point>;
}

/** What a click with the wire tool does. */
export type WireStep =
  | { readonly kind: "draft"; readonly draft: Draft }
  | { readonly kind: "finish"; readonly a: WireEnd; readonly via: ReadonlyArray<Point>; readonly b: WireEnd };

/** A wire holds at most this many waypoints; further clicks in open space are ignored. */
const MAX_VIA = 16;

export interface WireDrawing {
  draft: Draft | null;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  /** A press with the wire tool, on a pin or port (`target`), on a wire, or in open space. */
  wireClick: (target: PinTarget | null, onWire: string | null, world: Point) => void;
  /** A right click: one corner back, then the whole draft, then the tool. */
  cancelStep: () => void;
  wireUnder: (x: number, y: number) => string | null;
  /** The draft routed to the cursor, or to the pin or port under it. */
  draftPoints: Array<[number, number]> | null;
}

export function useWireDrawing({
  value,
  apply,
  byId,
  obstacles,
  routes,
  slack,
  mode,
  setMode,
  setPlaceKind,
  setHover,
  cursor,
  hover,
}: {
  value: Schematic;
  apply: (next: Schematic) => void;
  byId: ReadonlyMap<string, SchematicComponent>;
  obstacles: Obstacles;
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  slack: () => number;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPlaceKind: Dispatch<SetStateAction<ComponentKind | null>>;
  setHover: Dispatch<SetStateAction<PinTarget | null>>;
  cursor: Point;
  hover: PinTarget | null;
}): WireDrawing {
  const [draft, setDraft] = useState<Draft | null>(null);

  const finishWire = useCallback(
    (a: WireEnd, via: ReadonlyArray<Point>, b: WireEnd) => {
      const wire = finishedWire(value.wires, byId, obstacles, a, via, b);
      if (wire === null) return;
      apply({ components: value.components, wires: [...value.wires, wire] });
      setDraft(null);
      setHover(null);
    },
    [apply, byId, obstacles, setHover, value],
  );

  const wireClick = useCallback(
    (target: PinTarget | null, onWire: string | null, world: Point) => {
      const step = wireStep(draft, target, onWire, clampPoint(world.x, world.y));
      if (step === null) return;
      if (step.kind === "draft") setDraft(step.draft);
      else finishWire(step.a, step.via, step.b);
    },
    [draft, finishWire],
  );

  const cancelStep = useCallback(() => {
    if (draft !== null) {
      setDraft(draft.via.length > 0 ? { a: draft.a, via: draft.via.slice(0, -1) } : null);
      return;
    }
    if (mode !== "select") {
      setMode("select");
      setPlaceKind(null);
    }
  }, [draft, mode, setMode, setPlaceKind]);

  const wireUnder = useCallback(
    (x: number, y: number): string | null => {
      const r = slack();
      for (const [wid, points] of routes) {
        if (onPolyline(points, x, y, r)) return wid;
      }
      return null;
    },
    [routes, slack],
  );

  // --- the draft polyline, drawn under the cursor ------------------------
  const draftPoints = useMemo(() => {
    if (draft === null) return null;
    const a = resolveEnd(draft.a, byId);
    if (a === null) return null;
    const end = draftEnd(cursor, hover, byId);
    if (end === null) return null;
    return route([a, ...draft.via.map((v) => ({ x: v.x, y: v.y, d: -1 as const })), end], obstacles);
  }, [byId, cursor.x, cursor.y, draft, hover, obstacles]);

  return { draft, setDraft, wireClick, cancelStep, wireUnder, draftPoints };
}

const endOf = (target: PinTarget): WireEnd =>
  target.kind === "pin" ? { kind: "pin", c: target.c, p: target.p } : { kind: "port", port: target.port };

/** The first click: on a pin or port, or on a wire (a junction). Open space starts nothing. */
function firstStep(target: PinTarget | null, onWire: string | null, point: Point): WireStep | null {
  if (target !== null) return { kind: "draft", draft: { a: endOf(target), via: [] } };
  if (onWire !== null) return { kind: "draft", draft: { a: { kind: "free", ...point }, via: [] } };
  return null;
}

/**
 * What a click at `point` does to the draft. `point` is already clamped to
 * the box. A click back on the starting pin with no corner yet is ignored;
 * a second click on the last corner ends the wire there, as a free end.
 */
export function wireStep(
  draft: Draft | null,
  target: PinTarget | null,
  onWire: string | null,
  point: Point,
): WireStep | null {
  if (draft === null) return firstStep(target, onWire, point);
  if (target !== null) {
    const end = endOf(target);
    if (sameEnd(draft.a, end) && draft.via.length === 0) return null;
    return { kind: "finish", a: draft.a, via: draft.via, b: end };
  }
  if (onWire !== null) return { kind: "finish", a: draft.a, via: draft.via, b: { kind: "free", ...point } };
  const last = draft.via[draft.via.length - 1];
  if (last !== undefined && last.x === point.x && last.y === point.y) {
    /* A second click on the same spot: that corner becomes a free end. */
    return { kind: "finish", a: draft.a, via: draft.via.slice(0, -1), b: { kind: "free", ...point } };
  }
  if (draft.via.length >= MAX_VIA) return null;
  return { kind: "draft", draft: { a: draft.a, via: [...draft.via, point] } };
}

/** The finished wire, routed through its waypoints; `null` when an end no longer resolves. */
export function finishedWire(
  wires: readonly Wire[],
  byId: ReadonlyMap<string, SchematicComponent>,
  obstacles: Obstacles,
  a: WireEnd,
  via: ReadonlyArray<Point>,
  b: WireEnd,
): Wire | null {
  const pa = resolveEnd(a, byId);
  const pb = resolveEnd(b, byId);
  if (pa === null || pb === null) return null;
  const points = route([pa, ...via.map((v) => ({ x: v.x, y: v.y, d: -1 as const })), pb], obstacles);
  return {
    id: nextId(
      "w",
      wires.map((w) => w.id),
    ),
    a,
    b,
    via: via.map((v) => ({ x: v.x, y: v.y })),
    points,
  };
}

/** Where the draft ends right now: the hovered pin or port, else the cursor. */
function draftEnd(
  cursor: Point,
  hover: PinTarget | null,
  byId: ReadonlyMap<string, SchematicComponent>,
): PinPoint | null {
  if (hover === null) return { x: cursor.x, y: cursor.y, d: -1 };
  if (hover.kind === "port") return portPosition(hover.port);
  const c = byId.get(hover.c);
  return c === undefined ? null : pinPosition(c, hover.p);
}
