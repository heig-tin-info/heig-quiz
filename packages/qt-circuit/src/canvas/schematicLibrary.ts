/**
 * What the canvas needs to know about the parts it draws: the component
 * library it is PARAMETERIZED by (ADR-123 §1).
 *
 * The canvas — grid, parts, orthogonal wires, junctions, inspector — knows
 * no component kind of its own. A question type hands it a
 * {@link SchematicLibrary}: the pins, body and label anchor of each kind, its
 * drawing, its value (if any), the size of the box and the fixed ports on its
 * border. `circuit`'s library is `CIRCUIT_LIBRARY` (`circuitLibrary.ts`);
 * another type brings its own, without touching the canvas.
 *
 * The schematic the canvas edits is {@link CanvasSchematic}: the stored shape
 * of `circuit` (`schema.ts`) with the kind and the port as plain strings, so
 * `circuit`'s `Schematic` is one of them, unchanged.
 */
import type { PinSpec } from "../library.js";
import type { Orientation, Point } from "../schema.js";

import type { PartSpec, ValueIssue } from "../parts.js";
import type { SymbolSpec } from "./symbols.js";

export type { PartSpec, ValueIssue, ValueRole } from "../parts.js";
export { countedParts } from "../parts.js";

// ---------------------------------------------------------------------------
// The schematic, as the canvas sees it
// ---------------------------------------------------------------------------

export interface CanvasComponent {
  id: string;
  kind: string;
  x: number;
  y: number;
  m: Orientation;
  name: string;
  value: string;
}

export type CanvasWireEnd =
  | { kind: "pin"; c: string; p: number }
  | { kind: "port"; port: string }
  | { kind: "free"; x: number; y: number };

export interface CanvasWire {
  id: string;
  a: CanvasWireEnd;
  b: CanvasWireEnd;
  via: Array<{ x: number; y: number }>;
  points: Point[];
}

export interface CanvasSchematic {
  components: CanvasComponent[];
  wires: CanvasWire[];
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/**
 * A library must be a STABLE reference — a module constant, or a memoized
 * value — because the editor's hooks depend on it and its box keys the
 * fitted view: a library rebuilt on every render re-renders and re-routes
 * everything. Two variants are two constants (say, IEC and ANSI symbols).
 */
export interface SchematicLibrary {
  /** The box the parts and wires stay inside, in canvas units, a whole number of major cells. */
  readonly box: { readonly width: number; readonly height: number };
  /**
   * The fixed wire ends on the border of the box, in the order they are drawn;
   * `name` is the port's id in a wire end. Empty for a library without any.
   */
  readonly ports: readonly PinSpec[];
  /** Every kind the library declares. */
  readonly kinds: readonly string[];
  /** The kind's geometry; a kind the library does not declare is a bug, and throws. */
  part(kind: string): PartSpec;
  /**
   * The kind's drawing; `name` is the instance's, for a symbol that prints
   * it (a logic terminal hugs its name). A palette tile asks without one.
   */
  symbol(kind: string, name?: string): SymbolSpec;
  /** A number as the inspector writes it (a value's range). */
  formatValue(value: number): string;
  /** What is wrong with `value` for a part of that kind, or `null`. */
  valueIssue(kind: string, value: string): ValueIssue | null;
}

/** Whether a part of that kind is locked in place by the question. */
export const isLockedKind = (library: SchematicLibrary, kind: string): boolean => library.part(kind).locked === true;
