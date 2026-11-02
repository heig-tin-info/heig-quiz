/**
 * What a part of a schematic library IS, independent of how it is drawn:
 * shared by the canvas, the netlist extractor and the grader, so it imports
 * nothing at runtime and never pulls drawing code into the server.
 */
import type { PinSpec } from "./library.js";

/** What a part's single parameter means, when it has one. */
export type ValueRole =
  | { readonly kind: "none" }
  | { readonly kind: "quantity"; readonly unit: string; readonly min: number; readonly max: number };

export type ValueIssue = "missing" | "invalid" | "range";

/** One kind of part, in LOCAL coordinates on the grid. */
export interface PartSpec {
  /** The name prefix of an instance: `R` → R1, R2… A terminal's every instance bears the prefix itself. */
  readonly prefix: string;
  /** Default `value` of a fresh instance. */
  readonly defaultValue: string;
  readonly value: ValueRole;
  readonly pins: readonly PinSpec[];
  /** Body rectangle `[x, y, w, h]`: what a wire must route around. */
  readonly body: readonly [number, number, number, number];
  /** Label anchor; `null` for a symbol with no label. */
  readonly label_at: readonly [number, number] | null;
  /** Not counted against the palette's budget, and named by its prefix alone. */
  readonly terminal: boolean;
  /**
   * Placed by the question, not by the student: it moves and turns like any
   * part, but it is never deleted, renamed nor duplicated. `circuit` locks
   * nothing.
   */
  readonly locked?: boolean;
}

/** The parts counted against the palette's budget: every one that is not a terminal. */
export const countedParts = (
  components: readonly { kind: string }[],
  library: { part(kind: string): PartSpec },
): number => components.filter((c) => !library.part(c.kind).terminal).length;
