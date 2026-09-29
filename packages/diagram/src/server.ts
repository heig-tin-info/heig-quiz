/**
 * `@quiz/diagram/server`: the diagram engine without React (ADR-041 §1).
 * The scene model and its schema, the catalogue of kinds, the sizes and the
 * layout, and the text SERIALISER of each kind.
 *
 * The parsers are not exported here, on purpose (ADR-041 §2): the server
 * never parses a text written in a browser, and an entry that does not
 * offer a parser cannot be used to. The editor reads text through its own
 * modules.
 */
export * from "./scene.js";
export * from "./kinds.js";
export * from "./geometry.js";
export { layout, bounds, type End, type Layout, type LinkLike, type Route } from "./layout.js";
export { toText } from "./codecs/index.js";
export { EXAMPLES } from "./examples.js";
