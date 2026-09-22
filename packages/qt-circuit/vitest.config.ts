import { defineConfig } from "vitest/config";

/*
 * One jsdom environment for the whole package: the pure halves (schema,
 * netlist, spice, grade) do not care, and the component tests need a DOM.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
