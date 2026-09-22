/**
 * `@quiz/qt-circuit/canvas`: the drawing half of the `circuit` question type.
 *
 * Three components — the editor, the read-only view and the waveform plot —
 * plus the geometry they are built on, which the editor's host sometimes needs
 * too (mapping a netlist issue back onto a pin, for one).
 *
 * Everything here is UI. Nothing in this entry point extracts a netlist, emits
 * SPICE or grades anything; those live on the server side of the package.
 */
export { SchematicEditor, type SchematicEditorProps } from "./SchematicEditor.js";
export {
  ComponentGlyph,
  GridDefs,
  Junctions,
  Paper,
  Ports,
  SchematicView,
  SymbolPreview,
  WireGlyph,
  connectedPins,
  type ComponentGlyphProps,
  type FlaggedPin,
  type SchematicViewProps,
} from "./SchematicView.js";
export { Plot, formatTick, niceTicks, type PlotProps } from "./Plot.js";

export { CANVAS_STRINGS, withStrings, type CanvasStrings } from "./canvasStrings.js";

export {
  BLEED,
  FIT_VIEW,
  MIRROR_X,
  MIRROR_Y,
  ORIENTATIONS,
  ORIENT_0,
  ORIENT_90,
  ORIENT_180,
  ORIENT_270,
  ORIENT_MIRROR_0,
  ORIENT_MIRROR_90,
  ORIENT_MIRROR_180,
  ORIENT_MIRROR_270,
  ROTATE,
  clampPoint,
  clampToBox,
  directionOf,
  extentOf,
  hitRectOf,
  indexOf,
  multiply,
  newComponent,
  nextId,
  nextName,
  overlaps,
  pinAt,
  pinPosition,
  portPosition,
  rectOf,
  resolveEnd,
  sameEnd,
  screenToWorld,
  snap,
  transform,
  viewBoxAttr,
  viewScale,
  zoomAt,
  type PinPoint,
  type PinTarget,
  type Placement,
  type Rect,
  type ScreenRect,
  type ViewBox,
} from "./geometry.js";

export {
  blockedCells,
  computeRoutes,
  junctionPoints,
  markUsed,
  onPolyline,
  pathOf,
  route,
  simplify,
  withRoutes,
  type Obstacles,
} from "./router.js";

export { SYMBOLS, TOOL_ICONS, kindLabel, symbolOf, type SymbolMark, type SymbolShape, type SymbolSpec } from "./symbols.js";

export { useHistory, type History } from "./history.js";
