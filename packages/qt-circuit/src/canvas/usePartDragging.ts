/**
 * Dragging: parts across the grid, a waypoint of a selected wire, and a
 * palette tile onto the canvas.
 *
 * Every drag lands on the grid and inside the box, so nothing dropped can be
 * a value the schema rejects (spec §4.11: components are dropped on a grid).
 * A moved group is clamped as ONE group — it stops at the border instead of
 * deforming — and the wires wholly inside it travel with it. While a move is
 * in flight nothing is committed: `displayed` is the schematic as drawn, and
 * the host only hears of the move when it is let go.
 *
 * Hooks, in order: useState drag, useRef dragRef, useRef lastVia, useState
 * palDrag, useMemo displayed, useCallback componentUnder, useCallback
 * viaUnder, useEffect palette drop.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { BOX, type ComponentKind } from "../library.js";
import type { Orientation, Schematic, SchematicComponent, Wire, WireEnd } from "../schema.js";

import { clampPoint, clampToBox, extentOf, hitRectOf, snap } from "./geometry.js";
import { linkedWires, type BoxDrag } from "./useSelection.js";
import type { PanDrag, WorldPoint } from "./useViewport.js";

type Point = { x: number; y: number };
type Mode = "select" | "wire" | "place";

/** A press on a selected part: the selection follows the pointer, cell by cell. */
export interface MoveDrag {
  kind: "move";
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  moved: boolean;
  /** A plain click on an already selected part narrows the selection to it — on release, if it did not move. */
  collapse: string | null;
}

/** A press on a waypoint of a selected wire. */
export interface ViaDrag {
  kind: "via";
  wire: string;
  index: number;
  moved: boolean;
}

/** Whatever the pointer is doing while its button is down. */
export type Drag = MoveDrag | BoxDrag | PanDrag | ViaDrag;

/** The piece in hand while placing, drawn under the cursor. */
export interface Ghost {
  x: number;
  y: number;
  m: Orientation;
  show: boolean;
}

/** A palette tile held down: where it was pressed, and whether it has travelled. */
export interface PaletteDrag {
  kind: ComponentKind;
  x: number;
  y: number;
  moved: boolean;
  /** The tile was already armed: a click without travel disarms it. */
  rearm: boolean;
}

interface LastVia {
  wire: string;
  index: number;
  at: number;
}

/** Two presses on one waypoint within this many ms remove it. */
const SECOND_PRESS_MS = 380;
/** A palette tile becomes a drag past this many px of travel. */
const TILE_TRAVEL = 5;

export interface PartDragging {
  drag: Drag | null;
  setDrag: Dispatch<SetStateAction<Drag | null>>;
  /** The drag as of the last event, for handlers that must not wait for a render. */
  dragRef: RefObject<Drag | null>;
  lastVia: RefObject<LastVia | null>;
  setPalDrag: Dispatch<SetStateAction<PaletteDrag | null>>;
  /** The schematic as drawn: the value, with a move in flight applied. */
  displayed: Schematic;
  componentUnder: (x: number, y: number) => string | null;
  viaUnder: (x: number, y: number) => { wire: string; index: number } | null;
}

export function usePartDragging({
  value,
  selection,
  slack,
  toWorld,
  place,
  setGhost,
  setMode,
  setPlaceKind,
}: {
  value: Schematic;
  selection: ReadonlySet<string>;
  slack: () => number;
  toWorld: (clientX: number, clientY: number) => WorldPoint;
  place: (x: number, y: number) => void;
  setGhost: Dispatch<SetStateAction<Ghost>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPlaceKind: Dispatch<SetStateAction<ComponentKind | null>>;
}): PartDragging {
  const [drag, setDrag] = useState<Drag | null>(null);
  /* The drag mutates on every pointer move; a ref keeps the handler stable and
     the render cheap, and the state copy above is what the SVG draws from. */
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  /* A second press on the same waypoint removes it. `dblclick` will not do:
     the first press already started dragging that waypoint. */
  const lastVia = useRef<LastVia | null>(null);

  const [palDrag, setPalDrag] = useState<PaletteDrag | null>(null);

  const displayed = useMemo(() => {
    if (drag?.kind === "move" && drag.moved) return movedBy(value, selection, drag.dx, drag.dy);
    return value;
  }, [drag, selection, value]);

  const componentUnder = useCallback(
    (x: number, y: number): string | null => componentAt(displayed.components, x, y),
    [displayed],
  );

  const viaUnder = useCallback(
    (x: number, y: number): { wire: string; index: number } | null => viaAt(displayed.wires, selection, x, y, slack()),
    [displayed, selection, slack],
  );

  /* Dragging a palette tile onto the grid places one piece and stops there. */
  useEffect(() => {
    if (palDrag === null) return;
    const move = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - palDrag.x, e.clientY - palDrag.y) > TILE_TRAVEL) {
        setPalDrag((p) => (p === null ? p : { ...p, moved: true }));
        const w = toWorld(e.clientX, e.clientY);
        setGhost(ghostAt(palDrag.kind, snap(w.x), snap(w.y), w.inside));
      }
    };
    const up = (e: PointerEvent): void => {
      const pd = palDrag;
      setPalDrag(null);
      if (pd.moved) {
        const w = toWorld(e.clientX, e.clientY);
        if (w.inside) place(snap(w.x), snap(w.y));
      }
      if (pd.moved || pd.rearm) {
        setMode("select");
        setPlaceKind(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [palDrag, place, setGhost, setMode, setPlaceKind, toWorld]);

  return { drag, setDrag, dragRef, lastVia, setPalDrag, displayed, componentUnder, viaUnder };
}

// --- moving parts -------------------------------------------------------

/** The move the box allows, out of the one the pointer asked for. */
function clampDelta(components: readonly SchematicComponent[], dx: number, dy: number): { dx: number; dy: number } {
  let lowX = -Infinity;
  let highX = Infinity;
  let lowY = -Infinity;
  let highY = Infinity;
  for (const c of components) {
    const e = extentOf(c);
    lowX = Math.max(lowX, -e.x0);
    highX = Math.min(highX, BOX.width - e.x1);
    lowY = Math.max(lowY, -e.y0);
    highY = Math.min(highY, BOX.height - e.y1);
  }
  if (components.length === 0) return { dx, dy };
  return {
    dx: Math.min(Math.max(dx, lowX), Math.max(lowX, highX)),
    dy: Math.min(Math.max(dy, lowY), Math.max(lowY, highY)),
  };
}

/** The whole selection shifted by (dx, dy): components, waypoints and free ends. */
export function movedBy(schematic: Schematic, selection: ReadonlySet<string>, dx: number, dy: number): Schematic {
  const picked = schematic.components.filter((c) => selection.has(c.id));
  const d = clampDelta(picked, dx, dy);
  if (d.dx === 0 && d.dy === 0) return schematic;
  const pickedIds = new Set(picked.map((c) => c.id));
  const wires = new Set(linkedWires(schematic, selection).map((w) => w.id));
  const shiftEnd = (e: WireEnd): WireEnd =>
    e.kind === "free" ? { kind: "free", ...clampPoint(e.x + d.dx, e.y + d.dy) } : e;
  return {
    components: schematic.components.map((c) =>
      pickedIds.has(c.id) ? { ...c, ...clampToBox(c.kind, c.m, c.x + d.dx, c.y + d.dy) } : c,
    ),
    wires: schematic.wires.map((w) =>
      wires.has(w.id)
        ? {
            ...w,
            a: shiftEnd(w.a),
            b: shiftEnd(w.b),
            via: w.via.map((v) => clampPoint(v.x + d.dx, v.y + d.dy)),
          }
        : w,
    ),
  };
}

export function moveStart(w: Point, collapse: string | null): MoveDrag {
  return { kind: "move", sx: w.x, sy: w.y, dx: 0, dy: 0, moved: false, collapse };
}

/** The move at world point `w`, in whole cells; `null` while it stays in the same cell. */
export function moveStep(d: MoveDrag, w: Point): MoveDrag | null {
  const dx = snap(w.x - d.sx);
  const dy = snap(w.y - d.sy);
  return dx !== d.dx || dy !== d.dy ? { ...d, dx, dy, moved: true } : null;
}

/** The topmost component whose hit box holds (x, y). */
function componentAt(components: readonly SchematicComponent[], x: number, y: number): string | null {
  for (let i = components.length - 1; i >= 0; i -= 1) {
    const c = components[i];
    if (c === undefined) continue;
    const r = hitRectOf(c);
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return c.id;
  }
  return null;
}

// --- waypoints ----------------------------------------------------------

/** A waypoint of a SELECTED wire within `r` of (x, y): only those show a handle. */
function viaAt(
  wires: readonly Wire[],
  selection: ReadonlySet<string>,
  x: number,
  y: number,
  r: number,
): { wire: string; index: number } | null {
  for (const w of wires) {
    if (!selection.has(w.id)) continue;
    const index = w.via.findIndex((v) => Math.abs(v.x - x) <= r && Math.abs(v.y - y) <= r);
    if (index >= 0) return { wire: w.id, index };
  }
  return null;
}

/**
 * Records a press on a waypoint and says whether it is the SECOND press on it
 * in quick succession — the gesture that removes it.
 */
export function secondPress(
  last: { current: LastVia | null },
  via: { wire: string; index: number },
  now: number,
): boolean {
  const previous = last.current;
  const second =
    previous !== null && previous.wire === via.wire && previous.index === via.index && now - previous.at < SECOND_PRESS_MS;
  last.current = second ? null : { wire: via.wire, index: via.index, at: now };
  return second;
}

export function viaStart(via: { wire: string; index: number }): ViaDrag {
  return { kind: "via", wire: via.wire, index: via.index, moved: false };
}

/** The schematic without that one waypoint. */
export function withoutVia(value: Schematic, via: { wire: string; index: number }): Schematic {
  return {
    components: value.components,
    wires: value.wires.map((x) => (x.id === via.wire ? { ...x, via: x.via.filter((_, i) => i !== via.index) } : x)),
  };
}

/** The schematic with the dragged waypoint on grid point `at`; `null` when it is already there. */
export function viaMoved(value: Schematic, d: ViaDrag, at: Point): Schematic | null {
  const wire = value.wires.find((x) => x.id === d.wire);
  const v = wire?.via[d.index];
  if (wire === undefined || v === undefined || (v.x === at.x && v.y === at.y)) return null;
  const point = clampPoint(at.x, at.y);
  return {
    components: value.components,
    wires: value.wires.map((x) =>
      x.id === d.wire ? { ...x, via: x.via.map((p, i) => (i === d.index ? point : p)) } : x,
    ),
  };
}

// --- placing ------------------------------------------------------------

/** The ghost moved to grid point (x, y), kept inside the box. */
export const ghostAt =
  (kind: ComponentKind, x: number, y: number, show: boolean) =>
  (g: Ghost): Ghost => ({ ...g, ...clampToBox(kind, g.m, x, y), show });
