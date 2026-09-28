import { defineConfig } from "vitest/config";

import { domTests } from "../../vitest.shared.js";

/*
 * One jsdom environment for the whole package: the pure halves (schema,
 * netlist, spice, grade) do not care, and the component tests need a DOM.
 */
export default defineConfig(domTests);
