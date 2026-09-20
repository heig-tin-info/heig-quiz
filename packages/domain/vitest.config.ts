import { defineConfig } from "vitest/config";

/**
 * `packages/domain` holds the rules that decide a student's grade. Every line
 * of it is therefore executed by the unit tests, enforced here: a new rule
 * without a test fails the build, it does not merely lower a number.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text"],
      thresholds: { lines: 100 },
    },
  },
});
