import { defineConfig } from "vitest/config";
import { coverage, maxWorkers } from "../../vitest.shared.js";

/**
 * Every `*.db.test.ts` file boots its own PGlite, loaded with the migrated
 * database (test/db.ts). That is still a second of work per file, run
 * in parallel across the pool, so the 5 s default timeout of vitest is a
 * measure of machine load, not of the code under test — a new test file used
 * to push unrelated files over the edge. Same posture as
 * apps/codespace/vitest.config.ts.
 *
 * The chain is replayed once per run, not once per file: `globalSetup`
 * migrates one database and every file loads its own copy of it
 * (src/test/template.ts).
 *
 * `maxWorkers` is capped for the same reason, and for memory: each worker
 * holds a PGlite of ~800 MB, and several agents testing at once on one
 * workstation once exhausted its RAM. The formula (and its
 * VITEST_MAX_WORKERS override) is the one of ../../vitest.shared.ts.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/template.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    maxWorkers,
    // The demo world is a development script, never served.
    coverage: { ...coverage, exclude: [...coverage.exclude, "src/seed.ts", "src/seed/**"] },
  },
});
