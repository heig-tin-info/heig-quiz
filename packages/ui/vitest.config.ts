import { defineConfig } from "vitest/config";

import { domTests } from "../../vitest.shared.js";

/** One jsdom environment: every primitive of this package renders markup. */
export default defineConfig(domTests);
