import { defineConfig } from "vitest/config";

import { domTests } from "../../vitest.shared.js";

/*
 * One jsdom environment for the whole package: the pure halves (schema,
 * grade, canonical) do not care, and the component tests need a DOM. The
 * components fall back to a plain <textarea> under jsdom (see MonacoHost),
 * so no test ever reaches the Monaco CDN.
 */
export default defineConfig(domTests);
