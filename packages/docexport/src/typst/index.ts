/**
 * `@quiz/docexport/typst` — the PDF renderer (ADR-121 §7, ADR-125): the
 * document tree into Typst source, pure. The API compiles it
 * (`apps/api/src/typst/`).
 */
export type { AssetRef } from "./markdown.js";
export { BODY_MM, COLUMN_MM, drawable, printedWidthMm, PX_MM, renderTypst, type RenderedTypst } from "./render.js";
export { BODY_FONT } from "./template.js";
