import { defineConfig } from "vitest/config";

/**
 * Two projects, as in `apps/web`: the schema, grading and `toStudent` suites
 * stay in `node` (no DOM to boot), the component smoke tests get jsdom and the
 * Testing Library setup. `extends: true` reuses this file, so both transform
 * TSX the same way.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
          restoreMocks: true,
        },
      },
    ],
  },
});
