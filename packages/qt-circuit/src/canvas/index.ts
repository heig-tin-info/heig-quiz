/**
 * `@quiz/qt-circuit/canvas`: the drawing half of the `circuit` question type.
 *
 * Three components — the editor, the read-only view and the waveform plot —
 * and the strings they take. Everything here is UI. Nothing in this entry
 * point extracts a netlist, emits SPICE or grades anything; those live on the
 * server side of the package.
 *
 * The list is deliberately short: the geometry, the router, the symbol table
 * and the history hook are the canvas's own machinery, and a consumer that
 * reached for one of them would be re-implementing the editor. `withRoutes`
 * is the exception — a host that draws a stored schematic needs the wire
 * routes computed the same way the editor computes them.
 */
export { SchematicEditor, type SchematicEditorProps } from "./SchematicEditor.js";
export { SchematicView } from "./SchematicView.js";
export { Plot, type PlotProps } from "./Plot.js";
export { withRoutes } from "./router.js";

export { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
