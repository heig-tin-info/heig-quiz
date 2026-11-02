/**
 * `circuit`'s component library, as the canvas reads it: the analogue table
 * of `library.ts` (`CIRCUIT_PARTS`), the drawings of `symbols.ts`, the
 * quadripole box and its four ports. Nothing is locked.
 */
import { BOX, CIRCUIT_PARTS, COMPONENT_KINDS, PORT_IDS, PORTS, formatValue, valueIssue } from "../library.js";

import type { SchematicLibrary } from "./schematicLibrary.js";
import { SYMBOLS, type SymbolSpec } from "./symbols.js";

export const CIRCUIT_LIBRARY: SchematicLibrary = {
  box: BOX,
  ports: PORT_IDS.map((port) => PORTS[port]),
  kinds: COMPONENT_KINDS,
  part: CIRCUIT_PARTS.part,
  symbol: (kind: string): SymbolSpec => SYMBOLS[CIRCUIT_PARTS.part(kind).kind],
  formatValue,
  valueIssue: (kind, value) => valueIssue(CIRCUIT_PARTS.part(kind).kind, value),
};
