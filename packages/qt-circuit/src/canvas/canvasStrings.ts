/**
 * Every word the canvas puts on screen, English by default.
 *
 * A package cannot reach `apps/web`'s `t()`, so the host passes a `strings`
 * object filled from its own dictionary — which is where the French entries
 * live (N-I18N-01). The defaults exist so the components are usable, and
 * testable, on their own.
 */
import { LIBRARY, type ComponentKind, type PortId } from "../library.js";

export interface CanvasStrings {
  /** Accessible name of the editor's canvas, when the host gives none. */
  editorLabel: string;
  viewLabel: string;

  toolSelect: string;
  toolWire: string;

  components: string;
  /** "3 / 10" under the palette heading: what is placed against what is allowed. */
  componentCount: (used: number, max: number) => string;
  paletteFull: (max: number) => string;

  rotate: string;
  mirrorHorizontal: string;
  mirrorVertical: string;
  duplicate: string;
  remove: string;
  undo: string;
  redo: string;
  fit: string;

  inspector: string;
  fieldName: string;
  fieldValue: string;
  valueMissing: string;
  valueInvalid: string;
  valueRange: string;
  nameInvalid: string;

  modeSelect: string;
  modeWire: string;
  modePlace: string;
  hintSelect: string;
  hintSelection: (n: number) => string;
  hintWire: string;
  hintWireDrawing: string;
  hintPlace: (kind: string) => string;
  cursor: (x: number, y: number) => string;

  /** The label of a kind, for a palette tooltip and the inspector title. */
  kind: (kind: ComponentKind) => string;
  port: (port: PortId) => string;
  emptySchematic: string;

  plotEmpty: string;
  plotTime: string;
  plotVoltage: string;
  plotCurrent: string;
  seriesVin: string;
  seriesVout: string;
  seriesExpected: string;
  seriesIout: string;
  showCurrent: string;
}

export const CANVAS_STRINGS: CanvasStrings = {
  editorLabel: "Schematic editor",
  viewLabel: "Schematic",

  toolSelect: "Select",
  toolWire: "Wire",

  components: "Components",
  componentCount: (used, max) => `${used} / ${max}`,
  paletteFull: (max) => `You may place ${max} components.`,

  rotate: "Rotate",
  mirrorHorizontal: "Mirror horizontally",
  mirrorVertical: "Mirror vertically",
  duplicate: "Duplicate",
  remove: "Delete",
  undo: "Undo",
  redo: "Redo",
  fit: "Fit to view",

  inspector: "Selection",
  fieldName: "Name",
  fieldValue: "Value",
  valueMissing: "A value is required.",
  valueInvalid: "Not a value (try 4.7k, 100n, 1M).",
  valueRange: "Out of range for this component.",
  nameInvalid: "A letter, then letters, digits, _, + or −.",

  modeSelect: "Select",
  modeWire: "Wire",
  modePlace: "Place",
  hintSelect: "Pick a component on the left, then click the grid. Click a pin to start a wire.",
  hintSelection: (n) => (n === 1 ? "1 item selected. Drag to move, R to rotate, H or V to mirror." : `${n} items selected. Drag to move, R to rotate, H or V to mirror.`),
  hintWire: "Click a pin, a port, or an existing wire to branch off it.",
  hintWireDrawing: "Click to add a corner. Click a pin, a port or a wire to finish. Escape cancels.",
  hintPlace: (kind) => `${kind}: click to place, R to rotate, H or V to mirror, Escape to stop.`,
  cursor: (x, y) => `x ${x}  y ${y}`,

  kind: (kind) => LIBRARY[kind].label,
  port: (port) => port,
  emptySchematic: "Nothing drawn yet.",

  plotEmpty: "Run a simulation to see the output",
  plotTime: "ms",
  plotVoltage: "V",
  plotCurrent: "mA",
  seriesVin: "v(in)",
  seriesVout: "v(out)",
  seriesExpected: "expected v(out)",
  seriesIout: "i(out)",
  showCurrent: "Show current",
};

/** Fills the gaps of a partial override with the defaults above. */
export function withStrings<T extends object>(defaults: T, override?: Partial<T> | undefined): T {
  if (override === undefined) return defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
