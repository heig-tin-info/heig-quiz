/**
 * `@quiz/diagram/server`: the diagram engine without React (ADR-041 §1).
 * The scene model and its schema, the catalogue of kinds, the layout, the
 * text serialisers and parsers, all pure.
 */
export * from "./scene.js";
export * from "./kinds.js";
export * from "./geometry.js";
export { layout, simplify, DIRS, type End, type Layout, type LinkLike, type Route } from "./layout.js";
export { toText, parseText } from "./codecs/index.js";
export { PARSE_ERRORS, type ParseError, type ParseErrorCode, type Parsed } from "./codecs/parsed.js";
export { applyParsed } from "./apply.js";
export { EXAMPLES } from "./examples.js";
