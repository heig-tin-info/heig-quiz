/**
 * The pointer on the canvas: which tool a press goes to, what a move does to
 * the drag in flight, and what letting go commits.
 *
 * The three handlers only dispatch. Each concern is its own function below —
 * a press to place, to grab or drop a waypoint, to draw a wire, to select; a
 * move per kind of drag; a release per kind of drag — and the rules they
 * apply live with their tool (`useViewport`, `useSelection`,
 * `useWireDrawing`, `usePartDragging`).
 *
 * Hooks, in order: useCallback onPointerDown, useCallback onPointerMove,
 * useCallback onPointerUp.
 */
import {
  useCallback,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";

import type { ComponentKind } from "../library.js";
import type { Schematic } from "../schema.js";

import { pinAt, snap, type PinTarget, type ViewBox } from "./geometry.js";
import {
  ghostAt,
  moveStart,
  moveStep,
  movedBy,
  secondPress,
  viaMoved,
  viaStart,
  withoutVia,
  type Drag,
  type Ghost,
  type MoveDrag,
  type ViaDrag,
} from "./usePartDragging.js";
import { boxSelection, boxStart, pressed, type Mode } from "./useSelection.js";
import { panStart, panned, type WorldPoint } from "./useViewport.js";

type Point = { x: number; y: number };
type SvgPointer = ReactPointerEvent<SVGSVGElement>;

/** The cursor as the status bar shows it: on the grid, and whether it is over the canvas. */
export interface Cursor {
  x: number;
  y: number;
  inside: boolean;
}

/** Everything the pointer reads or sets, gathered from the editor and its hooks. */
export interface PointerTools {
  rootRef: RefObject<HTMLDivElement | null>;
  svgRef: RefObject<SVGSVGElement | null>;
  value: Schematic;
  apply: (next: Schematic, continuing?: boolean) => void;
  readOnly: boolean;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  placeKind: ComponentKind | null;
  place: (x: number, y: number) => void;
  view: ViewBox;
  setView: Dispatch<SetStateAction<ViewBox>>;
  toWorld: (clientX: number, clientY: number) => WorldPoint;
  slack: () => number;
  selection: ReadonlySet<string>;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  dragRef: RefObject<Drag | null>;
  setDrag: Dispatch<SetStateAction<Drag | null>>;
  lastVia: RefObject<{ wire: string; index: number; at: number } | null>;
  displayed: Schematic;
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  componentUnder: (x: number, y: number) => string | null;
  viaUnder: (x: number, y: number) => { wire: string; index: number } | null;
  wireUnder: (x: number, y: number) => string | null;
  wireClick: (target: PinTarget | null, onWire: string | null, world: Point) => void;
  cancelStep: () => void;
  setCursor: Dispatch<SetStateAction<Cursor>>;
  setGhost: Dispatch<SetStateAction<Ghost>>;
  setHover: Dispatch<SetStateAction<PinTarget | null>>;
}

export interface PointerHandlers {
  onPointerDown: (e: SvgPointer) => void;
  onPointerMove: (e: SvgPointer) => void;
  onPointerUp: (e: SvgPointer) => void;
}

export function usePointerTools(t: PointerTools): PointerHandlers {
  /* The handlers read everything through `t`, so these three dependency
     lists are kept BY HAND: each names every non-setter, non-ref field its
     handler (and the functions it calls) reads. Setters and refs are stable
     and stay out. Adding a field to `PointerTools` that a handler reads means
     adding it to that handler's list here — check all three — or the handler
     reads a stale value. */
  const onPointerDown = useCallback(
    (e: SvgPointer) => pointerDown(t, e),
    [
      t.apply,
      t.componentUnder,
      t.displayed.components,
      t.mode,
      t.place,
      t.readOnly,
      t.selection,
      t.slack,
      t.toWorld,
      t.value,
      t.view,
      t.viaUnder,
      t.wireClick,
      t.wireUnder,
    ],
  );

  const onPointerMove = useCallback(
    (e: SvgPointer) => pointerMove(t, e),
    [t.apply, t.displayed.components, t.mode, t.placeKind, t.readOnly, t.slack, t.toWorld, t.value],
  );

  const onPointerUp = useCallback(
    (e: SvgPointer) => pointerUp(t, e),
    [t.apply, t.cancelStep, t.displayed.components, t.routes, t.selection, t.value],
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}

// --- press --------------------------------------------------------------

function pointerDown(t: PointerTools, e: SvgPointer): void {
  t.rootRef.current?.focus({ preventScroll: true });
  const w = t.toWorld(e.clientX, e.clientY);
  t.setCursor({ x: snap(w.x), y: snap(w.y), inside: true });
  capture(t.svgRef.current, e.pointerId);
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    t.setDrag(panStart(e, t.view));
  } else if (e.button === 0) {
    leftPress(t, w, e.shiftKey);
  }
}

function capture(svg: SVGSVGElement | null, pointerId: number): void {
  try {
    svg?.setPointerCapture(pointerId);
  } catch {
    /* jsdom, and any browser that lost the pointer: the window listeners cover it. */
  }
}

/** A left press goes to the first tool that takes it: place, waypoint, wire, then selection. */
function leftPress(t: PointerTools, w: WorldPoint, shift: boolean): void {
  if (t.mode === "place" && !t.readOnly) {
    t.place(snap(w.x), snap(w.y));
    return;
  }
  const target = pinAt(t.displayed.components, w.x, w.y, t.slack());
  const onWire = t.wireUnder(w.x, w.y);
  if (!t.readOnly && (pressWaypoint(t, w) || pressWire(t, target, onWire, w, shift))) return;
  pressSelect(t, t.componentUnder(w.x, w.y) ?? onWire, w, shift);
}

/** On a waypoint of a selected wire, with the select tool: grab it, or drop it on a second press. */
function pressWaypoint(t: PointerTools, w: Point): boolean {
  const via = t.viaUnder(w.x, w.y);
  if (via === null || t.mode !== "select") return false;
  if (secondPress(t.lastVia, via, Date.now())) t.apply(withoutVia(t.value, via));
  else t.setDrag(viaStart(via));
  return true;
}

/** With the wire tool, or on a pin or port without Shift (which arms the wire tool). */
function pressWire(t: PointerTools, target: PinTarget | null, onWire: string | null, w: Point, shift: boolean): boolean {
  if (t.mode !== "wire" && (target === null || shift)) return false;
  if (t.mode !== "wire") t.setMode("wire");
  t.wireClick(target, onWire, w);
  return true;
}

/** On a part or a wire: select it, and grab the selection. In open space: a rubber band. */
function pressSelect(t: PointerTools, hitId: string | null, w: Point, shift: boolean): void {
  if (hitId === null) {
    t.setDrag(boxStart(w, shift, t.selection));
    if (!shift) t.setSelection(new Set());
    return;
  }
  const was = t.selection.has(hitId);
  const next = pressed(t.selection, hitId, shift);
  t.setSelection(next);
  if (next.has(hitId) && !t.readOnly) t.setDrag(moveStart(w, !shift && was ? hitId : null));
}

// --- move ---------------------------------------------------------------

function pointerMove(t: PointerTools, e: SvgPointer): void {
  const w = t.toWorld(e.clientX, e.clientY);
  const at = { x: snap(w.x), y: snap(w.y) };
  t.setCursor({ ...at, inside: w.inside });
  if (t.mode === "place" && t.placeKind !== null) t.setGhost(ghostAt(t.placeKind, at.x, at.y, w.inside));
  const d = t.dragRef.current;
  if (d === null) t.setHover(hoverAt(t, w));
  else dragTo(t, d, e, w, at);
}

/** The pin or port under a free pointer, for the tools that start wires. */
function hoverAt(t: PointerTools, w: WorldPoint): PinTarget | null {
  const armed = (t.mode === "wire" || t.mode === "select") && w.inside && !t.readOnly;
  return armed ? pinAt(t.displayed.components, w.x, w.y, t.slack()) : null;
}

function dragTo(t: PointerTools, d: Drag, e: SvgPointer, w: Point, at: Point): void {
  switch (d.kind) {
    case "pan":
      t.setView(panned(d, t.svgRef.current, e.clientX, e.clientY));
      return;
    case "move":
      dragParts(t, d, w);
      return;
    case "box":
      t.setDrag({ ...d, x1: w.x, y1: w.y });
      return;
    case "via":
      dragWaypoint(t, d, at);
      return;
  }
}

function dragParts(t: PointerTools, d: MoveDrag, w: Point): void {
  const next = moveStep(d, w);
  if (next !== null) t.setDrag(next);
}

/** A waypoint follows the pointer live; the whole drag is ONE undo step. */
function dragWaypoint(t: PointerTools, d: ViaDrag, at: Point): void {
  const next = viaMoved(t.value, d, at);
  if (next === null) return;
  t.apply(next, d.moved);
  t.setDrag({ ...d, moved: true });
}

// --- release ------------------------------------------------------------

function pointerUp(t: PointerTools, e: SvgPointer): void {
  const d = t.dragRef.current;
  t.setDrag(null);
  if (d === null) return;
  switch (d.kind) {
    case "pan":
      /* A right click that did not pan steps the wire tool back. */
      if (!d.moved && d.button === 2) t.cancelStep();
      return;
    case "move":
      releaseParts(t, d, e.shiftKey);
      return;
    case "box":
      t.setSelection(boxSelection(d, t.displayed.components, t.routes));
      return;
    case "via":
      return;
  }
}

/** A move commits on release; a click that did not move narrows the selection to what it hit. */
function releaseParts(t: PointerTools, d: MoveDrag, shift: boolean): void {
  if (d.moved) t.apply(movedBy(t.value, t.selection, d.dx, d.dy));
  else if (d.collapse !== null && !shift) t.setSelection(new Set([d.collapse]));
}
