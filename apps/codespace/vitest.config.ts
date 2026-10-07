import { defineConfig } from "vitest/config";

import { nodeTests } from "../../vitest.shared.js";

/**
 * The default run is the unit one: no Podman, no Forgejo, no network. The
 * suites that need rootful Podman or a forge only run with
 * CODESPACE_INTEGRATION=1 (`pnpm test:integration`), never in CI.
 */
const integration = [
  "src/engine/index.test.ts",
  "src/git/channel.integration.test.ts",
  "src/git/relay.test.ts",
  "src/sessions/sessions.test.ts",
];

export default defineConfig({
  test: {
    ...nodeTests.test,
    exclude: process.env["CODESPACE_INTEGRATION"] ? [] : integration,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
