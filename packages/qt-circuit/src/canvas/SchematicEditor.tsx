/**
 * The schematic editor: the React port of `mockups/circuit.html`.
 *
 * It is CONTROLLED. Every committed edit — a component placed, a drag let go
 * of, a wire finished, a deletion, a character typed in the inspector, an undo
 * — calls `onChange` with a NEW schematic whose wires carry freshly routed
 * `points`, because that polyline is what the server reads (`schema.ts`). What
 * is transient stays here: the selection, the wire being drawn, the drag, the
 * view box.
 *
 * Two differences from the mockup, both from the data model:
 * - the world IS the box (`0..BOX.width` × `0..BOX.height`). Components are
 *   clamped inside it and the router never leaves it, so nothing on the canvas
 *   can be a value the schema rejects;
 * - the four ports on the border are wire ends like any pin.
 *
 * Keyboard is scoped to the editor, never to the window: several of these may
 * sit on one page, and the app has shortcuts of its own.
 *
 * Hook order, as React sees it (flattened, top to bottom). It is recorded
 * here because the editor is being split into hooks, and a split must keep
 * the same hooks, unconditionally, in a stated order:
 *   1 useId                       18 useRef lastVia            35 useCallback toWorld
 *   2 useRef rootRef              19 useMemo kinds             36 useCallback slack
 *   3 useRef svgRef               20 useCallback apply         37 useCallback wireUnder
 *   4 useRef canvasRef            21 useMemo displayed         38 useCallback componentUnder
 *   5 useHistory (2 refs,         22 useMemo routes            39 useCallback viaUnder
 *     1 state, 4 callbacks)       23 useMemo obstacles         40 useCallback onPointerDown
 *   6 useState mode               24 useMemo connected         41 useCallback onPointerMove
 *   7 useState placeKind          25 useMemo byId              42 useCallback onPointerUp
 *   8 useState ghost              26 useCallback place         43 useEffect measure
 *   9 useState selection          27 useCallback removeSel.    44 useEffect wheel
 *  10 useState draft              28 useCallback transformSel. 45 useEffect palette drag
 *  11 useState drag               29 useCallback duplicate     46 useCallback onKeyDown
 *  12 useState view               30 useCallback undo          47 useMemo selectedComponent
 *  13 useState cursor             31 useCallback redo          48 useState nameDraft
 *  14 useState hover              32 useCallback finishWire    49 useRef editing
 *  15 useState palDrag            33 useCallback wireClick     50 useCallback editComponent
 *  16 useState canvasHeight       34 useCallback cancelStep    51 useMemo draftPoints
 *  17 useRef dragRef
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  BOX,
  GRID,
  LIBRARY,
  formatValue,
  valueIssue,
  type ComponentKind,
  type PortId,
} from "../library.js";
import {
  Schematic,
  countedComponents,
  type Orientation,
  type Palette,
  type SchematicComponent,
  type Supplies,
  type Wire,
  type WireEnd,
} from "../schema.js";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
import {
  canvasArea,
  cx,
  draftLine,
  fieldError,
  fieldInput,
  fieldInputInvalid,
  fieldLabel,
  frame,
  iconButton,
  inspector,
  inspectorTitle,
  marquee,
  paletteColumn,
  paletteCount,
  paletteGrid,
  paletteHead,
  paletteTile,
  paletteTileLabel,
  paletteTitle,
  readOnlyValue,
  separator,
  statusBar,
  statusCursor,
  statusHint,
  statusMode,
  toolButton,
  toolbar,
  toolbarGroup,
  crosshair,
} from "./canvasStyles.js";
import {
  MIRROR_X,
  MIRROR_Y,
  ORIENT_0,
  ROTATE,
  clampPoint,
  clampToBox,
  extentOf,
  hitRectOf,
  indexOf,
  multiply,
  newComponent,
  nextId,
  overlaps,
  pinAt,
  pinPosition,
  portPosition,
  resolveEnd,
  sameEnd,
  snap,
  viewBoxAttr,
  type PinPoint,
  type PinTarget,
} from "./geometry.js";
import { useHistory } from "./history.js";
import { blockedCells, computeRoutes, onPolyline, pathOf, route, withRoutes } from "./router.js";
import {
  ComponentGlyph,
  GridDefs,
  Junctions,
  Paper,
  Ports,
  SymbolPreview,
  WireGlyph,
  connectedPins,
  type FlaggedPin,
} from "./SchematicView.js";
import { TOOL_ICONS } from "./symbols.js";
import { panStart, panned, useViewport, type PanDrag } from "./useViewport.js";

export interface SchematicEditorProps {
  value: Schematic;
  /** Every committed edit, with a value that satisfies `Schematic.parse`. */
  onChange: (next: Schematic) => void;
  /** Only these kinds are offered; VCC and VEE also need their supply. */
  palette: Palette;
  supplies: Supplies;
  /** View and select only: no palette, no transform, no edit. */
  readOnly?: boolean | undefined;
  /** Pins to mark as a problem — the host maps its netlist issues onto these. */
  highlightPins?: readonly FlaggedPin[] | undefined;
  highlightPorts?: readonly PortId[] | undefined;
  strings?: Partial<CanvasStrings> | undefined;
  /**
   * The TALLEST the drawing area gets, in px. It is normally shorter: the
   * area takes the shape of the fitted view for the width it was given.
   */
  height?: number | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
}

type Mode = "select" | "wire" | "place";

type Drag =
  | { kind: "move"; sx: number; sy: number; dx: number; dy: number; moved: boolean; collapse: string | null }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; base: ReadonlySet<string> }
  | PanDrag
  | { kind: "via"; wire: string; index: number; moved: boolean };

interface Draft {
  readonly a: WireEnd;
  readonly via: ReadonlyArray<{ x: number; y: number }>;
}

const isTerminal = (kind: ComponentKind): boolean => LIBRARY[kind].terminal;

const endOf = (target: PinTarget): WireEnd =>
  target.kind === "pin" ? { kind: "pin", c: target.c, p: target.p } : { kind: "port", port: target.port };

/** Selected wires, plus the wires wholly inside the selected components. */
function linkedWires(schematic: Schematic, selection: ReadonlySet<string>): Wire[] {
  const picked = new Set(schematic.components.filter((c) => selection.has(c.id)).map((c) => c.id));
  return schematic.wires.filter(
    (w) =>
      selection.has(w.id) ||
      (w.a.kind === "pin" && w.b.kind === "pin" && picked.has(w.a.c) && picked.has(w.b.c)),
  );
}

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
function movedBy(schematic: Schematic, selection: ReadonlySet<string>, dx: number, dy: number): Schematic {
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

/** After a rotation, the offset that brings the whole group back inside the box. */
function fitOffset(components: readonly SchematicComponent[]): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const c of components) {
    const e = extentOf(c);
    if (e.x0 + dx < 0) dx = -e.x0;
    if (e.y0 + dy < 0) dy = -e.y0;
  }
  for (const c of components) {
    const e = extentOf(c);
    if (e.x1 + dx > BOX.width) dx = BOX.width - e.x1;
    if (e.y1 + dy > BOX.height) dy = BOX.height - e.y1;
  }
  return { dx: snap(dx), dy: snap(dy) };
}

export function SchematicEditor({
  value,
  onChange,
  palette,
  supplies,
  readOnly = false,
  highlightPins,
  highlightPorts,
  strings,
  height = 420,
  id,
  "aria-label": ariaLabel,
}: SchematicEditorProps): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const reactId = useId();
  const patternId = (id ?? reactId).replace(/[^A-Za-z0-9_-]/g, "_");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const history = useHistory<Schematic>();
  const [mode, setMode] = useState<Mode>("select");
  const [placeKind, setPlaceKind] = useState<ComponentKind | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; m: Orientation; show: boolean }>({
    x: 200,
    y: 200,
    m: ORIENT_0,
    show: false,
  });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { view, setView, canvasHeight, toWorld, slack, fit, zoom } = useViewport(svgRef, canvasRef, height);
  const [cursor, setCursor] = useState<{ x: number; y: number; inside: boolean }>({
    x: 0,
    y: 0,
    inside: false,
  });
  const [hover, setHover] = useState<PinTarget | null>(null);
  const [palDrag, setPalDrag] = useState<{ kind: ComponentKind; x: number; y: number; moved: boolean; rearm: boolean } | null>(
    null,
  );

  /* The drag mutates on every pointer move; a ref keeps the handler stable and
     the render cheap, and the state copy above is what the SVG draws from. */
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  /* A second press on the same waypoint removes it. `dblclick` will not do:
     the first press already started dragging that waypoint. */
  const lastVia = useRef<{ wire: string; index: number; at: number } | null>(null);

  // --- what the palette offers ------------------------------------------
  const kinds = useMemo(
    () =>
      palette.kinds.filter(
        (k) => (k !== "VCC" || supplies.vcc !== null) && (k !== "VEE" || supplies.vee !== null),
      ),
    [palette.kinds, supplies.vcc, supplies.vee],
  );
  const used = countedComponents(value, isTerminal);
  const full = used >= palette.maxComponents;

  // --- committing --------------------------------------------------------
  const apply = useCallback(
    (next: Schematic, continuing = false) => {
      if (!continuing) history.push(value);
      onChange(withRoutes(next));
    },
    [history, onChange, value],
  );

  // --- what is drawn right now ------------------------------------------
  const displayed = useMemo(() => {
    if (drag?.kind === "move" && drag.moved) return movedBy(value, selection, drag.dx, drag.dy);
    return value;
  }, [drag, selection, value]);

  const routes = useMemo(() => computeRoutes(displayed), [displayed]);
  const obstacles = useMemo(
    () => ({ blocked: blockedCells(displayed.components), used: new Map<string, number>() }),
    [displayed],
  );
  const connected = useMemo(() => connectedPins(displayed), [displayed]);
  const byId = useMemo(() => indexOf(displayed.components), [displayed]);

  // --- operations --------------------------------------------------------

  const place = useCallback(
    (x: number, y: number) => {
      if (placeKind === null || readOnly) return;
      if (!isTerminal(placeKind) && full) return;
      const c = newComponent(placeKind, x, y, ghost.m, value.components);
      apply({ components: [...value.components, c], wires: value.wires });
      setSelection(new Set([c.id]));
    },
    [apply, full, ghost.m, placeKind, readOnly, value],
  );

  const removeSelection = useCallback(() => {
    if (readOnly || selection.size === 0) return;
    const gone = new Set(value.components.filter((c) => selection.has(c.id)).map((c) => c.id));
    apply({
      components: value.components.filter((c) => !gone.has(c.id)),
      wires: value.wires.filter(
        (w) =>
          !selection.has(w.id) &&
          !(w.a.kind === "pin" && gone.has(w.a.c)) &&
          !(w.b.kind === "pin" && gone.has(w.b.c)),
      ),
    });
    setSelection(new Set());
  }, [apply, readOnly, selection, value]);

  const transformSelection = useCallback(
    (t: Orientation) => {
      if (readOnly) return;
      if (mode === "place") {
        setGhost((g) => ({ ...g, m: multiply(t, g.m) }));
        return;
      }
      const picked = value.components.filter((c) => selection.has(c.id));
      const wires = linkedWires(value, selection);
      const points: Array<[number, number]> =
        picked.length > 0
          ? picked.map((c) => [c.x, c.y])
          : wires.flatMap((w) => [
              ...w.via.map((v) => [v.x, v.y] as [number, number]),
              ...[w.a, w.b]
                .filter((e): e is Extract<WireEnd, { kind: "free" }> => e.kind === "free")
                .map((e) => [e.x, e.y] as [number, number]),
            ]);
      if (points.length === 0) return;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const cxc = snap((Math.min(...xs) + Math.max(...xs)) / 2);
      const cyc = snap((Math.min(...ys) + Math.max(...ys)) / 2);
      const turn = (x: number, y: number): [number, number] => [
        cxc + t[0] * (x - cxc) + t[2] * (y - cyc),
        cyc + t[1] * (x - cxc) + t[3] * (y - cyc),
      ];
      const pickedIds = new Set(picked.map((c) => c.id));
      const wireIds = new Set(wires.map((w) => w.id));
      let components = value.components.map((c) => {
        if (!pickedIds.has(c.id)) return c;
        const [nx, ny] = turn(c.x, c.y);
        return { ...c, x: nx, y: ny, m: multiply(t, c.m) };
      });
      const off = fitOffset(components.filter((c) => pickedIds.has(c.id)));
      components = components.map((c) =>
        pickedIds.has(c.id) ? { ...c, ...clampToBox(c.kind, c.m, c.x + off.dx, c.y + off.dy) } : c,
      );
      const turnEnd = (e: WireEnd): WireEnd => {
        if (e.kind !== "free") return e;
        const [nx, ny] = turn(e.x, e.y);
        return { kind: "free", ...clampPoint(nx + off.dx, ny + off.dy) };
      };
      apply({
        components,
        wires: value.wires.map((w) => {
          if (!wireIds.has(w.id)) return w;
          return {
            ...w,
            a: turnEnd(w.a),
            b: turnEnd(w.b),
            via: w.via.map((v) => {
              const [nx, ny] = turn(v.x, v.y);
              return clampPoint(nx + off.dx, ny + off.dy);
            }),
          };
        }),
      });
    },
    [apply, mode, readOnly, selection, value],
  );

  const duplicate = useCallback(() => {
    if (readOnly) return;
    const picked = value.components.filter((c) => selection.has(c.id));
    if (picked.length === 0) return;
    const extra = picked.filter((c) => !isTerminal(c.kind)).length;
    if (used + extra > palette.maxComponents) return;
    const off = 2 * GRID;
    const components = [...value.components];
    const wires = [...value.wires];
    const map = new Map<string, string>();
    const fresh = new Set<string>();
    for (const c of picked) {
      const n: SchematicComponent = {
        ...newComponent(c.kind, c.x + off, c.y + off, c.m, components),
        value: c.value,
      };
      components.push(n);
      map.set(c.id, n.id);
      fresh.add(n.id);
    }
    for (const w of linkedWires(value, selection)) {
      if (w.a.kind !== "pin" || w.b.kind !== "pin") continue;
      const a = map.get(w.a.c);
      const b = map.get(w.b.c);
      if (a === undefined || b === undefined) continue;
      const n: Wire = {
        id: nextId(
          "w",
          wires.map((x) => x.id),
        ),
        a: { kind: "pin", c: a, p: w.a.p },
        b: { kind: "pin", c: b, p: w.b.p },
        via: w.via.map((v) => clampPoint(v.x + off, v.y + off)),
        points: w.points,
      };
      wires.push(n);
      fresh.add(n.id);
    }
    apply({ components, wires });
    setSelection(fresh);
  }, [apply, palette.maxComponents, readOnly, selection, used, value]);

  const undo = useCallback(() => {
    const previous = history.undo(value);
    if (previous === undefined) return;
    setSelection(new Set());
    setDraft(null);
    onChange(previous);
  }, [history, onChange, value]);

  const redo = useCallback(() => {
    const next = history.redo(value);
    if (next === undefined) return;
    setSelection(new Set());
    setDraft(null);
    onChange(next);
  }, [history, onChange, value]);

  // --- the wire tool -----------------------------------------------------

  const finishWire = useCallback(
    (a: WireEnd, via: ReadonlyArray<{ x: number; y: number }>, b: WireEnd) => {
      const pa = resolveEnd(a, byId);
      const pb = resolveEnd(b, byId);
      if (pa === null || pb === null) return;
      const points = route([pa, ...via.map((v) => ({ x: v.x, y: v.y, d: -1 as const })), pb], obstacles);
      const wire: Wire = {
        id: nextId(
          "w",
          value.wires.map((w) => w.id),
        ),
        a,
        b,
        via: via.map((v) => ({ x: v.x, y: v.y })),
        points,
      };
      apply({ components: value.components, wires: [...value.wires, wire] });
      setDraft(null);
      setHover(null);
    },
    [apply, byId, obstacles, value],
  );

  const wireClick = useCallback(
    (target: PinTarget | null, onWire: string | null, world: { x: number; y: number }) => {
      const point = clampPoint(world.x, world.y);
      if (draft === null) {
        if (target !== null) setDraft({ a: endOf(target), via: [] });
        else if (onWire !== null) setDraft({ a: { kind: "free", ...point }, via: [] });
        return;
      }
      if (target !== null) {
        const end = endOf(target);
        if (sameEnd(draft.a, end) && draft.via.length === 0) return;
        finishWire(draft.a, draft.via, end);
        return;
      }
      if (onWire !== null) {
        finishWire(draft.a, draft.via, { kind: "free", ...point });
        return;
      }
      const last = draft.via[draft.via.length - 1];
      if (last !== undefined && last.x === point.x && last.y === point.y) {
        /* A second click on the same spot: that corner becomes a free end. */
        finishWire(draft.a, draft.via.slice(0, -1), { kind: "free", ...point });
        return;
      }
      if (draft.via.length >= 16) return;
      setDraft({ a: draft.a, via: [...draft.via, point] });
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
  }, [draft, mode]);

  // --- the pointer -------------------------------------------------------

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

  const componentUnder = useCallback(
    (x: number, y: number): string | null => {
      for (let i = displayed.components.length - 1; i >= 0; i -= 1) {
        const c = displayed.components[i];
        if (c === undefined) continue;
        const r = hitRectOf(c);
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return c.id;
      }
      return null;
    },
    [displayed],
  );

  const viaUnder = useCallback(
    (x: number, y: number): { wire: string; index: number } | null => {
      const r = slack();
      for (const w of displayed.wires) {
        if (!selection.has(w.id)) continue;
        for (let i = 0; i < w.via.length; i += 1) {
          const v = w.via[i];
          if (v === undefined) continue;
          if (Math.abs(v.x - x) <= r && Math.abs(v.y - y) <= r) return { wire: w.id, index: i };
        }
      }
      return null;
    },
    [displayed, selection, slack],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      rootRef.current?.focus({ preventScroll: true });
      const w = toWorld(e.clientX, e.clientY);
      setCursor({ x: snap(w.x), y: snap(w.y), inside: true });
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom, and any browser that lost the pointer: the window listeners cover it. */
      }
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        setDrag(panStart(e, view));
        return;
      }
      if (e.button !== 0) return;

      if (mode === "place" && !readOnly) {
        place(snap(w.x), snap(w.y));
        return;
      }

      const target = pinAt(displayed.components, w.x, w.y, slack());
      const onWire = wireUnder(w.x, w.y);

      if (!readOnly) {
        const via = viaUnder(w.x, w.y);
        if (via !== null && mode === "select") {
          const now = Date.now();
          const previous = lastVia.current;
          if (
            previous !== null &&
            previous.wire === via.wire &&
            previous.index === via.index &&
            now - previous.at < 380
          ) {
            lastVia.current = null;
            apply({
              components: value.components,
              wires: value.wires.map((x) =>
                x.id === via.wire ? { ...x, via: x.via.filter((_, i) => i !== via.index) } : x,
              ),
            });
            return;
          }
          lastVia.current = { wire: via.wire, index: via.index, at: now };
          setDrag({ kind: "via", wire: via.wire, index: via.index, moved: false });
          return;
        }
        if (mode === "wire" || (target !== null && !e.shiftKey)) {
          if (mode !== "wire") setMode("wire");
          wireClick(target, onWire, w);
          return;
        }
      }

      const hitId = componentUnder(w.x, w.y) ?? onWire;
      if (hitId !== null) {
        const was = selection.has(hitId);
        let next = new Set(selection);
        if (e.shiftKey) {
          if (was) next.delete(hitId);
          else next.add(hitId);
        } else if (!was) {
          next = new Set([hitId]);
        }
        setSelection(next);
        if (next.has(hitId) && !readOnly) {
          setDrag({
            kind: "move",
            sx: w.x,
            sy: w.y,
            dx: 0,
            dy: 0,
            moved: false,
            collapse: !e.shiftKey && was ? hitId : null,
          });
        }
        return;
      }
      setDrag({
        kind: "box",
        x0: w.x,
        y0: w.y,
        x1: w.x,
        y1: w.y,
        base: e.shiftKey ? new Set(selection) : new Set(),
      });
      if (!e.shiftKey) setSelection(new Set());
    },
    [
      apply,
      componentUnder,
      displayed.components,
      mode,
      place,
      readOnly,
      selection,
      slack,
      toWorld,
      value,
      view,
      viaUnder,
      wireClick,
      wireUnder,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const w = toWorld(e.clientX, e.clientY);
      const at = { x: snap(w.x), y: snap(w.y) };
      setCursor({ ...at, inside: w.inside });
      if (mode === "place" && placeKind !== null) {
        setGhost((g) => ({ ...g, ...clampToBox(placeKind, g.m, at.x, at.y), show: w.inside }));
      }

      const d = dragRef.current;
      if (d === null) {
        setHover(
          (mode === "wire" || mode === "select") && w.inside && !readOnly
            ? pinAt(displayed.components, w.x, w.y, slack())
            : null,
        );
        return;
      }
      if (d.kind === "pan") {
        setView(panned(d, svgRef.current, e.clientX, e.clientY));
      } else if (d.kind === "move") {
        const dx = snap(w.x - d.sx);
        const dy = snap(w.y - d.sy);
        if (dx !== d.dx || dy !== d.dy) setDrag({ ...d, dx, dy, moved: true });
      } else if (d.kind === "box") {
        setDrag({ ...d, x1: w.x, y1: w.y });
      } else if (d.kind === "via") {
        const wire = value.wires.find((x) => x.id === d.wire);
        const v = wire?.via[d.index];
        if (wire !== undefined && v !== undefined && (v.x !== at.x || v.y !== at.y)) {
          const point = clampPoint(at.x, at.y);
          if (!d.moved) history.push(value);
          setDrag({ ...d, moved: true });
          onChange(
            withRoutes({
              components: value.components,
              wires: value.wires.map((x) =>
                x.id === d.wire
                  ? { ...x, via: x.via.map((p, i) => (i === d.index ? point : p)) }
                  : x,
              ),
            }),
          );
        }
      }
    },
    [displayed.components, history, mode, onChange, placeKind, readOnly, slack, toWorld, value],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      setDrag(null);
      if (d === null) return;
      if (d.kind === "pan") {
        if (!d.moved && d.button === 2) cancelStep();
        return;
      }
      if (d.kind === "move") {
        if (d.moved) apply(movedBy(value, selection, d.dx, d.dy));
        else if (d.collapse !== null && !e.shiftKey) setSelection(new Set([d.collapse]));
        return;
      }
      if (d.kind === "box") {
        const x0 = Math.min(d.x0, d.x1);
        const x1 = Math.max(d.x0, d.x1);
        const y0 = Math.min(d.y0, d.y1);
        const y1 = Math.max(d.y0, d.y1);
        const rect = { x0, y0, x1, y1 };
        const next = new Set(d.base);
        for (const c of displayed.components) {
          if (overlaps(hitRectOf(c), rect)) next.add(c.id);
        }
        for (const [wid, points] of routes) {
          if (points.every((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) next.add(wid);
        }
        setSelection(next);
      }
    },
    [apply, displayed.components, routes, selection, value],
  );

  /* Dragging a palette tile onto the grid places one piece and stops there. */
  useEffect(() => {
    if (palDrag === null) return;
    const move = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - palDrag.x, e.clientY - palDrag.y) > 5) {
        setPalDrag((p) => (p === null ? p : { ...p, moved: true }));
        const w = toWorld(e.clientX, e.clientY);
        setGhost((g) => ({ ...g, ...clampToBox(palDrag.kind, g.m, snap(w.x), snap(w.y)), show: w.inside }));
      }
    };
    const up = (e: PointerEvent): void => {
      const pd = palDrag;
      setPalDrag(null);
      if (pd.moved) {
        const w = toWorld(e.clientX, e.clientY);
        if (w.inside) place(snap(w.x), snap(w.y));
        setMode("select");
        setPlaceKind(null);
      } else if (pd.rearm) {
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
  }, [palDrag, place, toWorld]);

  // --- the keyboard, scoped to this editor -------------------------------

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const k = e.key;
      const lower = k.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (lower === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (lower === "y") {
          e.preventDefault();
          redo();
        } else if (lower === "d") {
          e.preventDefault();
          duplicate();
        } else if (lower === "a") {
          e.preventDefault();
          setSelection(new Set([...value.components.map((c) => c.id), ...value.wires.map((w) => w.id)]));
        }
        return;
      }
      if (k === " " || lower === "r") {
        e.preventDefault();
        transformSelection(ROTATE);
      } else if (lower === "h") {
        transformSelection(MIRROR_X);
      } else if (lower === "v") {
        transformSelection(MIRROR_Y);
      } else if (lower === "w" && !readOnly) {
        setMode(mode === "wire" ? "select" : "wire");
        setPlaceKind(null);
        setDraft(null);
      } else if (k === "Delete" || k === "Backspace") {
        e.preventDefault();
        removeSelection();
      } else if (k === "Escape") {
        if (draft !== null) setDraft(null);
        else if (mode !== "select") {
          setMode("select");
          setPlaceKind(null);
        } else setSelection(new Set());
      } else if (/^[1-9]$/.test(k) && !readOnly) {
        const kind = kinds[Number(k) - 1];
        if (kind !== undefined) {
          setMode("place");
          setPlaceKind(kind);
          setDraft(null);
        }
      }
    },
    [draft, duplicate, kinds, mode, readOnly, redo, removeSelection, transformSelection, undo, value],
  );

  // --- the inspector -----------------------------------------------------

  const selectedComponent = useMemo(() => {
    const ids = [...selection];
    if (ids.length !== 1) return null;
    return value.components.find((c) => c.id === ids[0]) ?? null;
  }, [selection, value.components]);

  const [nameDraft, setNameDraft] = useState<{ id: string; text: string } | null>(null);
  const editing = useRef(false);

  const nameText = nameDraft !== null && nameDraft.id === selectedComponent?.id ? nameDraft.text : (selectedComponent?.name ?? "");
  const nameOk = /^[A-Za-z][A-Za-z0-9_+-]{0,11}$/.test(nameText);

  const editComponent = useCallback(
    (patch: Partial<SchematicComponent>) => {
      if (selectedComponent === null) return;
      const continuing = editing.current;
      editing.current = true;
      apply(
        {
          components: value.components.map((c) => (c.id === selectedComponent.id ? { ...c, ...patch } : c)),
          wires: value.wires,
        },
        continuing,
      );
    },
    [apply, selectedComponent, value],
  );

  // --- the draft polyline, drawn under the cursor ------------------------

  const draftPoints = useMemo(() => {
    if (draft === null) return null;
    const a = resolveEnd(draft.a, byId);
    if (a === null) return null;
    let end: PinPoint | null = { x: cursor.x, y: cursor.y, d: -1 };
    if (hover !== null) {
      if (hover.kind === "port") end = portPosition(hover.port);
      else {
        const c = byId.get(hover.c);
        end = c === undefined ? null : pinPosition(c, hover.p);
      }
    }
    if (end === null) return null;
    return route([a, ...draft.via.map((v) => ({ x: v.x, y: v.y, d: -1 as const })), end], obstacles);
  }, [byId, cursor.x, cursor.y, draft, hover, obstacles]);

  // --- render ------------------------------------------------------------

  const hint =
    mode === "place" && placeKind !== null
      ? fmt(s.hintPlace, { kind: s.kind(placeKind) })
      : mode === "wire"
        ? draft !== null
          ? s.hintWireDrawing
          : s.hintWire
        : selection.size > 0
          ? plural(s, "hintSelection", selection.size)
          : s.hintSelect;
  const modeName = mode === "place" ? s.modePlace : mode === "wire" ? s.modeWire : s.modeSelect;

  const hoveredPinOf = (componentId: string): number | null =>
    hover !== null && hover.kind === "pin" && hover.c === componentId ? hover.p : null;

  return (
    <div
      ref={rootRef}
      id={id}
      className={cx(frame, "focus-visible:outline-none")}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel ?? s.editorLabel}
      onKeyDown={onKeyDown}
    >
      <div className={toolbar}>
        {readOnly ? null : (
          <>
            <div className={toolbarGroup}>
              <button
                type="button"
                className={toolButton(mode === "select")}
                aria-pressed={mode === "select"}
                onClick={() => {
                  setMode("select");
                  setPlaceKind(null);
                  setDraft(null);
                }}
              >
                <Icon name="select" />
                {s.toolSelect}
              </button>
              <button
                type="button"
                className={toolButton(mode === "wire")}
                aria-pressed={mode === "wire"}
                onClick={() => {
                  setMode("wire");
                  setPlaceKind(null);
                }}
              >
                <Icon name="wire" />
                {s.toolWire}
              </button>
            </div>
            <span className={separator} aria-hidden="true" />
            <div className={toolbarGroup}>
              <IconButton label={s.rotate} name="rotate" onClick={() => transformSelection(ROTATE)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.mirrorHorizontal} name="mirrorH" onClick={() => transformSelection(MIRROR_X)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.mirrorVertical} name="mirrorV" onClick={() => transformSelection(MIRROR_Y)} disabled={selection.size === 0 && mode !== "place"} />
              <IconButton label={s.duplicate} name="duplicate" onClick={duplicate} disabled={![...selection].some((x) => x.startsWith("c"))} />
              <IconButton label={s.remove} name="remove" onClick={removeSelection} disabled={selection.size === 0} />
            </div>
            <span className={separator} aria-hidden="true" />
            <div className={toolbarGroup}>
              <IconButton label={s.undo} name="undo" onClick={undo} disabled={!history.canUndo} />
              <IconButton label={s.redo} name="redo" onClick={redo} disabled={!history.canRedo} />
            </div>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <span className={cx(statusCursor, "text-[11px] text-fg-faint")}>{zoom} %</span>
          <IconButton label={s.fit} name="fit" onClick={fit} />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row">
        {readOnly ? null : (
          <div className={paletteColumn} style={{ maxHeight: canvasHeight }}>
            <div className={paletteHead}>
              <span className={paletteTitle}>{s.components}</span>
              <span className={paletteCount}>{fmt(s.componentCount, { used, max: palette.maxComponents })}</span>
            </div>
            <div className={paletteGrid}>
              {kinds.map((kind) => {
                const disabled = full && !isTerminal(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    className={paletteTile(mode === "place" && placeKind === kind)}
                    aria-pressed={mode === "place" && placeKind === kind}
                    aria-label={s.kind(kind)}
                    title={s.kind(kind)}
                    disabled={disabled}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || disabled) return;
                      const rearm = mode === "place" && placeKind === kind;
                      setMode("place");
                      setPlaceKind(kind);
                      setDraft(null);
                      setGhost((g) => ({ ...g, m: ORIENT_0 }));
                      setPalDrag({ kind, x: e.clientX, y: e.clientY, moved: false, rearm });
                    }}
                  >
                    <SymbolPreview kind={kind} width={48} height={22} />
                    <span className={paletteTileLabel}>{kind}</span>
                  </button>
                );
              })}
            </div>
            {full ? <p className="px-0.5 text-[11px] text-fg-faint">{fmt(s.paletteFull, { max: palette.maxComponents })}</p> : null}
          </div>
        )}

        <div ref={canvasRef} className={canvasArea} style={{ height: canvasHeight }}>
          <svg
            ref={svgRef}
            data-testid="schematic-canvas"
            role="application"
            aria-label={ariaLabel ?? s.editorLabel}
            viewBox={viewBoxAttr(view)}
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            height="100%"
            className={cx("block touch-none select-none", mode === "wire" && "cursor-crosshair", mode === "place" && "cursor-copy")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              setCursor((c) => ({ ...c, inside: false }));
              setGhost((g) => ({ ...g, show: false }));
              setHover(null);
            }}
            onDoubleClick={(e) => {
              const w = toWorld(e.clientX, e.clientY);
              if (componentUnder(w.x, w.y) === null && wireUnder(w.x, w.y) === null && draft === null) {
                fit();
              }
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <GridDefs id={patternId} />
            <Paper id={patternId} />
            <g>
              {displayed.wires.map((w) => {
                const points = routes.get(w.id);
                return points === undefined ? null : (
                  <WireGlyph key={w.id} wire={w} points={points} selected={selection.has(w.id)} />
                );
              })}
            </g>
            <Junctions schematic={displayed} routes={routes} />
            <g>
              {displayed.components.map((c) => (
                <ComponentGlyph
                  key={c.id}
                  component={c}
                  selected={selection.has(c.id)}
                  connected={connected}
                  hoveredPin={hoveredPinOf(c.id)}
                  {...(highlightPins === undefined ? {} : { flaggedPins: highlightPins })}
                />
              ))}
            </g>
            <Ports
              strings={s}
              {...(highlightPorts === undefined ? {} : { flagged: highlightPorts })}
              hovered={hover?.kind === "port" ? hover.port : null}
            />

            {/* Everything below is transient: it is never stored. */}
            <g className="pointer-events-none">
              {draftPoints !== null ? (
                <>
                  <path className={draftLine} d={pathOf(draftPoints)} />
                  {draft?.via.map((v, i) => (
                    <circle key={i} className="fill-accent" cx={v.x} cy={v.y} r={3} />
                  ))}
                </>
              ) : null}
              {selection.size > 0
                ? displayed.wires
                    .filter((w) => selection.has(w.id))
                    .flatMap((w) =>
                      w.via.map((v, i) => (
                        <rect
                          key={`${w.id}-${i}`}
                          className="fill-surface stroke-accent stroke-[1.6]"
                          x={v.x - 4.5}
                          y={v.y - 4.5}
                          width={9}
                          height={9}
                          rx={1.5}
                        />
                      )),
                    )
                : null}
              {mode === "place" && ghost.show && placeKind !== null ? (
                <ComponentGlyph
                  ghost
                  component={{ id: "ghost", kind: placeKind, x: ghost.x, y: ghost.y, m: ghost.m, name: "", value: "" }}
                />
              ) : null}
              {mode === "wire" && cursor.inside && hover === null ? (
                <path className={crosshair} d={`M${cursor.x - 6} ${cursor.y}h12M${cursor.x} ${cursor.y - 6}v12`} />
              ) : null}
              {drag?.kind === "box" ? (
                <rect
                  className={marquee}
                  x={Math.min(drag.x0, drag.x1)}
                  y={Math.min(drag.y0, drag.y1)}
                  width={Math.abs(drag.x1 - drag.x0)}
                  height={Math.abs(drag.y1 - drag.y0)}
                />
              ) : null}
            </g>
          </svg>

          {selectedComponent !== null ? (
            <div className={inspector}>
              <span className={inspectorTitle}>{s.kind(selectedComponent.kind)}</span>
              {readOnly ? (
                <>
                  <span className={readOnlyValue}>{selectedComponent.name}</span>
                  {selectedComponent.value !== "" ? (
                    <span className={readOnlyValue}>{selectedComponent.value}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabel}>{s.fieldName}</span>
                    <input
                      className={nameOk ? fieldInput : fieldInputInvalid}
                      value={nameText}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!nameOk}
                      onFocus={() => {
                        editing.current = false;
                      }}
                      onChange={(e) => {
                        const text = e.target.value;
                        setNameDraft({ id: selectedComponent.id, text });
                        if (/^[A-Za-z][A-Za-z0-9_+-]{0,11}$/.test(text)) editComponent({ name: text });
                      }}
                      onBlur={() => setNameDraft(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                      }}
                    />
                  </label>
                  {nameOk ? null : <span className={fieldError}>{s.nameInvalid}</span>}
                  <ValueField
                    component={selectedComponent}
                    strings={s}
                    onEdit={(v) => editComponent({ value: v })}
                    onFocus={() => {
                      editing.current = false;
                    }}
                  />
                </>
              )}
            </div>
          ) : null}

        </div>
      </div>

      <div className={statusBar}>
        <span className={statusMode}>{modeName}</span>
        <span className={statusHint}>{hint}</span>
        <span className={statusCursor}>{fmt(s.cursor, { x: cursor.x, y: cursor.y })}</span>
      </div>
    </div>
  );
}

/** The value box, with the unit the library declares and a live verdict. */
function ValueField({
  component,
  strings,
  onEdit,
  onFocus,
}: {
  component: SchematicComponent;
  strings: CanvasStrings;
  onEdit: (value: string) => void;
  onFocus: () => void;
}): JSX.Element | null {
  const role = LIBRARY[component.kind].value;
  if (role.kind === "none") return null;
  const issue = valueIssue(component.kind, component.value);
  const message =
    issue === "missing"
      ? strings.valueMissing
      : issue === "invalid"
        ? strings.valueInvalid
        : issue === "range"
          ? `${strings.valueRange} ${formatValue(role.min)}…${formatValue(role.max)}${role.unit}`
          : null;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>
          {strings.fieldValue} <span className="font-mono">({role.unit})</span>
        </span>
        <input
          className={issue === null ? fieldInput : fieldInputInvalid}
          value={component.value}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={issue !== null}
          maxLength={24}
          onFocus={onFocus}
          onChange={(e) => onEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </label>
      {message === null ? null : <span className={fieldError}>{message}</span>}
    </>
  );
}

function Icon({ name }: { name: keyof typeof TOOL_ICONS }): JSX.Element {
  const paths = TOOL_ICONS[name] ?? [];
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function IconButton({
  label,
  name,
  onClick,
  disabled = false,
}: {
  label: string;
  name: keyof typeof TOOL_ICONS;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button type="button" className={iconButton()} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={name} />
    </button>
  );
}
