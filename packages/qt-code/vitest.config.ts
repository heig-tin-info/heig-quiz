import { defineConfig } from "vitest/config";

/*
 * One jsdom environment for the whole package: the pure halves (schema,
 * grade, canonical) do not care, and the component tests need a DOM. The
 * components fall back to a plain <textarea> under jsdom (see MonacoHost),
 * so no test ever reaches the Monaco CDN.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
