/**
 * Real SVG diagrams a teacher drew for a course (UML), as they were handed
 * over: what the strict check of ADR-134 must accept, the upload route store
 * and Typst draw.
 */
import { readFileSync } from "node:fs";

export const SVG_FIXTURES = ["interface.svg", "cas-utilisation.svg", "relation-1.svg"].map((name) => ({
  name,
  bytes: readFileSync(new URL(`./fixtures/svg/${name}`, import.meta.url)),
}));
