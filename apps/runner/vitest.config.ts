import { defineConfig } from "vitest/config";

import { nodeTests } from "../../vitest.shared.js";

/**
 * The default run is the unit one: a fake engine, no container, no Podman.
 * The integration suite lives in `*.int.test.ts` and has its own config, so
 * `pnpm test` at the root stays green on a machine with no container engine.
 */
export default defineConfig({
  test: {
    ...nodeTests.test,
    exclude: ["src/**/*.int.test.ts"],
  },
});
