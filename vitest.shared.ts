/**
 * The vitest settings the packages share. Each `vitest.config.ts` passes one
 * of these to `defineConfig`, adding what is its own (a coverage gate, an
 * exclusion). This file imports nothing but Node: the root has no `vitest`
 * dependency, and the config bundler inlines a relative import anyway.
 *
 * `maxWorkers` follows apps/api/vitest.config.ts, which says why: `pnpm -r
 * test` starts up to four packages at once, each with vitest's default of
 * cores - 1 workers, and that exhausted a shared workstation's RAM.
 * VITEST_MAX_WORKERS overrides it.
 */
import { availableParallelism } from "node:os";

export const maxWorkers =
  Number(process.env.VITEST_MAX_WORKERS) || Math.max(1, Math.min(6, availableParallelism() - 1));

/**
 * What `vitest run --coverage` measures, in every package: the sources, never
 * the tests nor their helpers. Off by default (a plain run pays nothing);
 * `pnpm test:coverage` turns it on and scripts/coverage-summary.mjs reads the
 * `json-summary` of each package against coverage.floors.json.
 */
export const coverage = {
  provider: "v8" as const,
  include: ["src/**/*.{ts,tsx}"],
  exclude: ["src/**/*.test.{ts,tsx}", "src/test/**"],
  reporter: ["text-summary", "json-summary", "html"],
};

/** Testing Library under jsdom; `src/test/setup.ts` unmounts after each test. */
const dom = {
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
  restoreMocks: true,
};

/** Pure code: every `*.test.ts` in `node`. */
export const nodeTests = {
  test: { include: ["src/**/*.test.ts"], maxWorkers, coverage },
};

/** One jsdom environment for the whole package, `.ts` and `.tsx` tests alike. */
export const domTests = {
  test: { ...dom, include: ["src/**/*.test.ts", "src/**/*.test.tsx"], maxWorkers, coverage },
};

/**
 * Two projects, as in `apps/web`: the schema, grading and `toStudent` suites
 * stay in `node` (no DOM to boot), the component smoke tests (`*.test.tsx`)
 * get jsdom and the Testing Library setup. `extends: true` reuses the root
 * config, so both transform TSX the same way.
 */
export const splitTests = {
  test: {
    maxWorkers,
    coverage,
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { ...dom, name: "dom", include: ["src/**/*.test.tsx"] },
      },
    ],
  },
};
