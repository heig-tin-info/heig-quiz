/**
 * Every word the canvas puts on screen, English by default.
 *
 * A package cannot reach `apps/web`'s `t()`, so the host passes a `strings`
 * object filled from its own dictionary — which is where the French entries
 * live (N-I18N-01). The defaults exist so the components are usable, and
 * testable, on their own.
 *
 * A parameterised sentence is a TEMPLATE filled by `fmt` from
 * `@quiz/core/client` (`"Case {n}"`), never a function: the host's `t()` uses
 * the same `{var}` syntax, so it translates these entries key by key like any
 * other. A count-dependent sentence has a `<key>.one` sibling, used for 1.
 */
import { LIBRARY, type ComponentKind, type PortId } from "../library.js";

export const CANVAS_STRINGS = {
  /** Accessible name of the editor's canvas, when the host gives none. */
  editorLabel: "Schematic editor",
  viewLabel: "Schematic",

  toolSelect: "Select",
  toolWire: "Wire",

  components: "Components",
  /** "3 / 10" under the palette heading: what is placed against what is allowed. */
  componentCount: "{used} / {max}",
  paletteFull: "You may place {max} components.",

  rotate: "Rotate",
  mirrorHorizontal: "Mirror horizontally",
  mirrorVertical: "Mirror vertically",
  duplicate: "Duplicate",
  remove: "Delete",
  undo: "Undo",
  redo: "Redo",
  fit: "Fit to view",
  /** The shortcut zone's lines (`SHORTCUT_LINES`); W and Del reuse `toolWire` and `remove`. */
  shortcutUndoRedo: "Undo / Redo",
  shortcutTransform: "Rotate / Mirror",
  shortcutPart: "Pick a part",

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
  hintSelection: "{n} items selected. Drag to move, R to rotate, H or V to mirror.",
  "hintSelection.one": "1 item selected. Drag to move, R to rotate, H or V to mirror.",
  hintWire: "Click a pin, a port, or an existing wire to branch off it.",
  hintWireDrawing: "Click to add a corner. Click a pin, a port or a wire to finish. Escape cancels.",
  hintPlace: "{kind}: click to place, R to rotate, H or V to mirror, Escape to stop.",
  cursor: "x {x}  y {y}",

  /** The label of a kind, for a palette tooltip and the inspector title. */
  kind: (kind: ComponentKind): string => LIBRARY[kind].label,
  port: (port: PortId): string => port,
  emptySchematic: "Nothing drawn yet.",

  plotEmpty: "Run a simulation to see the output",
  plotTime: "ms",
  plotVoltage: "V",
  plotCurrent: "mA",
  plotFrequency: "Hz",
  plotMagnitude: "dB",
  plotPhase: "°",
  /** Accessible name of a Bode plot that has no title. */
  bodeLabel: "Bode plot of the output",
  seriesVin: "v(in)",
  seriesVout: "v(out)",
  seriesExpected: "expected v(out)",
  seriesIout: "i(out)",
  showCurrent: "Show current",
};

export type CanvasStrings = typeof CANVAS_STRINGS;
