import { defineConfig } from "vitest/config";

/**
 * `pnpm --filter @quiz/runner test:integration` — the suite that really
 * starts containers. Every file skips itself when the Podman socket is not
 * reachable, so running it on a machine without Podman reports skips, not
 * failures. A whole suite is one container start per request plus one per
 * case, hence the generous timeouts.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Containers are a global resource: one file at a time keeps the load
    // test measuring the runner's queue rather than vitest's parallelism.
    fileParallelism: false,
  },
});
