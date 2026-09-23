/**
 * What the editor has selected, and what can be done to it: delete, rotate,
 * mirror, duplicate — from the toolbar or from the keyboard.
 *
 * The selection is a set of ids, components and wires mixed; a wire whose two
 * ends sit on selected components travels with them (`linkedWires`). Every
 * edit is computed by a plain function below and committed through the
 * editor's `apply`, so the selection never writes the schematic itself.
 *
 * Hooks, in order: useState selection, useCallback removeSelection,
 * useCallback transformSelection, useCallback duplicate.
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import { BOX, GRID, LIBRARY, type ComponentKind } from "../library.js";
import type { Orientation, Schematic, SchematicComponent, Wire, WireEnd } from "../schema.js";

import {
  MIRROR_X,
  MIRROR_Y,
  ROTATE,
  clampPoint,
  clampToBox,
  extentOf,
  hitRectOf,
  multiply,
  newComponent,
  nextId,
  overlaps,
  snap,
} from "./geometry.js";

type Apply = (next: Schematic, continuing?: boolean) => void;
type Point = { x: number; y: number };

/** A press in open space: the rubber band, and what was selected before it. */
export interface BoxDrag {
  kind: "box";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: ReadonlySet<string>;
}

export interface Selection {
  selection: ReadonlySet<string>;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  removeSelection: () => void;
  /** Rotates or mirrors the selection — or, while placing, the piece in hand. */
  transformSelection: (t: Orientation) => void;
  duplicate: () => void;
}

export const isTerminal = (kind: ComponentKind): boolean => LIBRARY[kind].terminal;

export function useSelection<G extends { m: Orientation }>({
  value,
  apply,
  readOnly,
  placing,
  setGhost,
  used,
  maxComponents,
}: {
  value: Schematic;
  apply: Apply;
  readOnly: boolean;
  /** The place tool is armed: a transform turns the ghost, not the selection. */
  placing: boolean;
  setGhost: Dispatch<SetStateAction<G>>;
  /** Components counted against the budget, and the budget. */
  used: number;
  maxComponents: number;
}): Selection {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());

  const removeSelection = useCallback(() => {
    if (readOnly || selection.size === 0) return;
    apply(removed(value, selection));
    setSelection(new Set());
  }, [apply, readOnly, selection, value]);

  const transformSelection = useCallback(
    (t: Orientation) => {
      if (readOnly) return;
      if (placing) {
        setGhost((g) => ({ ...g, m: multiply(t, g.m) }));
        return;
      }
      const next = transformed(value, selection, t);
      if (next !== null) apply(next);
    },
    [apply, placing, readOnly, selection, setGhost, value],
  );

  const duplicate = useCallback(() => {
    if (readOnly) return;
    const picked = value.components.filter((c) => selection.has(c.id));
    if (picked.length === 0) return;
    const extra = picked.filter((c) => !isTerminal(c.kind)).length;
    if (used + extra > maxComponents) return;
    const copy = duplicated(value, selection, picked);
    apply(copy.schematic);
    setSelection(copy.fresh);
  }, [apply, maxComponents, readOnly, selection, used, value]);

  return { selection, setSelection, removeSelection, transformSelection, duplicate };
}

// --- the edits, as plain functions --------------------------------------

/** Selected wires, plus the wires wholly inside the selected components. */
export function linkedWires(schematic: Schematic, selection: ReadonlySet<string>): Wire[] {
  const picked = new Set(schematic.components.filter((c) => selection.has(c.id)).map((c) => c.id));
  return schematic.wires.filter(
    (w) =>
      selection.has(w.id) ||
      (w.a.kind === "pin" && w.b.kind === "pin" && picked.has(w.a.c) && picked.has(w.b.c)),
  );
}

/** The schematic without the selection, and without the wires that hung off it. */
export function removed(value: Schematic, selection: ReadonlySet<string>): Schematic {
  const gone = new Set(value.components.filter((c) => selection.has(c.id)).map((c) => c.id));
  return {
    components: value.components.filter((c) => !gone.has(c.id)),
    wires: value.wires.filter(
      (w) =>
        !selection.has(w.id) &&
        !(w.a.kind === "pin" && gone.has(w.a.c)) &&
        !(w.b.kind === "pin" && gone.has(w.b.c)),
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

/** The waypoints and free ends of a wire: what turns when no component does. */
const loosePointsOf = (w: Wire): Array<[number, number]> => [
  ...w.via.map((v) => [v.x, v.y] as [number, number]),
  ...[w.a, w.b]
    .filter((e): e is Extract<WireEnd, { kind: "free" }> => e.kind === "free")
    .map((e) => [e.x, e.y] as [number, number]),
];

/** The grid point a transform turns about: the middle of what it moves. */
function pivotOf(picked: readonly SchematicComponent[], wires: readonly Wire[]): Point | null {
  const points: Array<[number, number]> =
    picked.length > 0 ? picked.map((c) => [c.x, c.y]) : wires.flatMap(loosePointsOf);
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: snap((Math.min(...xs) + Math.max(...xs)) / 2),
    y: snap((Math.min(...ys) + Math.max(...ys)) / 2),
  };
}

/**
 * The selection rotated or mirrored by `t` about its middle, then shifted
 * back inside the box as one group. `null` when nothing would move.
 */
export function transformed(value: Schematic, selection: ReadonlySet<string>, t: Orientation): Schematic | null {
  const picked = value.components.filter((c) => selection.has(c.id));
  const wires = linkedWires(value, selection);
  const pivot = pivotOf(picked, wires);
  if (pivot === null) return null;
  const turn = (x: number, y: number): [number, number] => [
    pivot.x + t[0] * (x - pivot.x) + t[2] * (y - pivot.y),
    pivot.y + t[1] * (x - pivot.x) + t[3] * (y - pivot.y),
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
  const turnPoint = (p: Point): Point => {
    const [nx, ny] = turn(p.x, p.y);
    return clampPoint(nx + off.dx, ny + off.dy);
  };
  const turnEnd = (e: WireEnd): WireEnd => (e.kind !== "free" ? e : { kind: "free", ...turnPoint(e) });
  return {
    components,
    wires: value.wires.map((w) =>
      wireIds.has(w.id) ? { ...w, a: turnEnd(w.a), b: turnEnd(w.b), via: w.via.map(turnPoint) } : w,
    ),
  };
}

/**
 * The picked components copied two cells down and right, with the wires that
 * ran between two of them. `fresh` is the new ids: the copy becomes the
 * selection.
 */
export function duplicated(
  value: Schematic,
  selection: ReadonlySet<string>,
  picked: readonly SchematicComponent[],
): { schematic: Schematic; fresh: Set<string> } {
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
    const n = copiedWire(w, map, wires, off);
    if (n === null) continue;
    wires.push(n);
    fresh.add(n.id);
  }
  return { schematic: { components, wires }, fresh };
}

/** A pin-to-pin wire re-attached to the copies of its two components. */
function copiedWire(w: Wire, map: ReadonlyMap<string, string>, wires: readonly Wire[], off: number): Wire | null {
  if (w.a.kind !== "pin" || w.b.kind !== "pin") return null;
  const a = map.get(w.a.c);
  const b = map.get(w.b.c);
  if (a === undefined || b === undefined) return null;
  return {
    id: nextId(
      "w",
      wires.map((x) => x.id),
    ),
    a: { kind: "pin", c: a, p: w.a.p },
    b: { kind: "pin", c: b, p: w.b.p },
    via: w.via.map((v) => clampPoint(v.x + off, v.y + off)),
    points: w.points,
  };
}

// --- the pointer --------------------------------------------------------

/** A click on `hitId`: Shift toggles it, a plain click on something new selects only it. */
export function pressed(selection: ReadonlySet<string>, hitId: string, shift: boolean): ReadonlySet<string> {
  const was = selection.has(hitId);
  let next = new Set(selection);
  if (shift) {
    if (was) next.delete(hitId);
    else next.add(hitId);
  } else if (!was) {
    next = new Set([hitId]);
  }
  return next;
}

/** A rubber band from `w`; with Shift it adds to the selection instead of replacing it. */
export function boxStart(w: Point, shift: boolean, selection: ReadonlySet<string>): BoxDrag {
  return { kind: "box", x0: w.x, y0: w.y, x1: w.x, y1: w.y, base: shift ? new Set(selection) : new Set() };
}

/** What a released rubber band selects: components it touches, wires it wholly contains. */
export function boxSelection(
  d: BoxDrag,
  components: readonly SchematicComponent[],
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): ReadonlySet<string> {
  const x0 = Math.min(d.x0, d.x1);
  const x1 = Math.max(d.x0, d.x1);
  const y0 = Math.min(d.y0, d.y1);
  const y1 = Math.max(d.y0, d.y1);
  const rect = { x0, y0, x1, y1 };
  const next = new Set(d.base);
  for (const c of components) {
    if (overlaps(hitRectOf(c), rect)) next.add(c.id);
  }
  for (const [wid, points] of routes) {
    if (points.every((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) next.add(wid);
  }
  return next;
}

// --- the keyboard -------------------------------------------------------

/** What a key can ask of the editor. */
export interface KeyActions {
  undo: () => void;
  redo: () => void;
  duplicate: () => void;
  selectAll: () => void;
  transform: (t: Orientation) => void;
  toggleWire: () => void;
  remove: () => void;
  escape: () => void;
  /** Arms the palette kind at this index (0-based). */
  arm: (index: number) => void;
}

interface KeyBinding {
  /** Swallow the browser's own meaning of the key (scroll, back, …). */
  prevent: boolean;
  /** Ignored in a read-only editor. */
  edit: boolean;
  run: (a: KeyActions, key: string) => void;
}

const bind = (run: KeyBinding["run"], prevent = false, edit = false): KeyBinding => ({ prevent, edit, run });

/** With Ctrl or Cmd, by lower-cased key. Shift+Ctrl+Z is redo. */
const CHORDS = new Map<string, (a: KeyActions, shift: boolean) => void>([
  ["z", (a, shift) => (shift ? a.redo() : a.undo())],
  ["y", (a) => a.redo()],
  ["d", (a) => a.duplicate()],
  ["a", (a) => a.selectAll()],
]);

/** Plain letters, by lower-cased key. */
const LETTERS = new Map<string, KeyBinding>([
  [" ", bind((a) => a.transform(ROTATE), true)],
  ["r", bind((a) => a.transform(ROTATE), true)],
  ["h", bind((a) => a.transform(MIRROR_X))],
  ["v", bind((a) => a.transform(MIRROR_Y))],
  ["w", bind((a) => a.toggleWire(), false, true)],
]);

/** Named keys, exactly as the browser spells them. */
const NAMED = new Map<string, KeyBinding>([
  ["Delete", bind((a) => a.remove(), true)],
  ["Backspace", bind((a) => a.remove(), true)],
  ["Escape", bind((a) => a.escape())],
]);

const DIGIT = bind((a, key) => a.arm(Number(key) - 1), false, true);

const bindingOf = (key: string): KeyBinding | undefined =>
  LETTERS.get(key.toLowerCase()) ?? NAMED.get(key) ?? (/^[1-9]$/.test(key) ? DIGIT : undefined);

/** A key pressed while typing in the inspector belongs to the field, not the editor. */
const isTextField = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
};

/** The editor's keyboard, as one lookup: chords first, then single keys. */
export function editorKey(
  e: {
    key: string;
    target: EventTarget | null;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
  },
  actions: KeyActions,
  readOnly: boolean,
): void {
  if (isTextField(e.target)) return;
  if (e.ctrlKey || e.metaKey) {
    const chord = CHORDS.get(e.key.toLowerCase());
    if (chord === undefined) return;
    e.preventDefault();
    chord(actions, e.shiftKey);
    return;
  }
  const binding = bindingOf(e.key);
  if (binding === undefined || (binding.edit && readOnly)) return;
  if (binding.prevent) e.preventDefault();
  binding.run(actions, e.key);
}
