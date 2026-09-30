import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { coverage, maxWorkers } from "../../vitest.shared.js";

/**
 * `virtual:lucide-aliases`: alias -> canonical lucide names, so the pool icon
 * catalogue lists each glyph once (#165). Nothing at runtime tells them apart,
 * but in `dynamicIconImports` an alias imports its canonical's file. Parsed at
 * build time from the installed package; an unparsable format fails the build.
 */
function lucideAliases(): Plugin {
  const id = "virtual:lucide-aliases";
  return {
    name: "lucide-aliases",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      const file = createRequire(import.meta.url).resolve(
        "lucide-react/dist/esm/dynamicIconImports.mjs",
      );
      const source = readFileSync(file, "utf8");
      const entries = [...source.matchAll(/"([^"]+)": \(\) => import\('\.\/icons\/([^']+)\.mjs'\)/g)];
      const total = source.match(/import\(/g)?.length ?? 0;
      if (entries.length === 0 || entries.length !== total) {
        throw new Error(`lucide-aliases: parsed ${entries.length} of ${total} entries in ${file}`);
      }
      const aliases = Object.fromEntries(
        entries.filter(([, name, target]) => name !== target).map(([, name, target]) => [name, target]),
      );
      return `export default ${JSON.stringify(aliases)};`;
    },
  };
}

/**
 * The commit this build is made of (#179), for the user menu. CI passes it to
 * the image build (`COMMIT_SHA`, `COMMIT_DATE`: the Docker context has no
 * `.git`); a local build asks git; with neither the entry is left out.
 */
function commit(): { sha: string; date: string } | null {
  const { COMMIT_SHA: sha, COMMIT_DATE: date } = process.env;
  if (sha && date) return { sha, date };
  try {
    const [head, when] = execFileSync("git", ["log", "-1", "--format=%H%n%cI"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    return head && when ? { sha: head, date: when } : null;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), lucideAliases()],
  define: { __COMMIT__: JSON.stringify(commit()) },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // The icons the app imports statically. `dynamicIconImports`
              // (the pool icon catalogue) makes every icon file its own
              // import target, so each statically used one was split into a
              // chunk of its own and the first load preloaded ~77 files of a
              // few hundred bytes. `$initial` keeps the group to what the
              // entry reaches statically: the catalogue's other icons stay
              // lazy, one chunk each.
              name: "lucide-icons",
              test: /lucide-react[\\/]dist[\\/]esm[\\/]/,
              tags: ["$initial"],
              // Lucide's modules only: an icon's dependencies are
              // `createLucideIcon` (matched above) and React, which must stay
              // in its own chunk rather than be dragged in here.
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    // Listen on every interface: under WSL2 the browser runs on the Windows
    // side and reaches the dev server through the VM's address, not localhost.
    host: true,
    // Fail loudly when :5173 is taken rather than drift to :5174: a stale dev
    // server once left the browser on the wrong port with nothing to say.
    strictPort: true,
    // Standalone dev: the backend stays the sole origin for cookies.
    proxy: {
      "/app": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
      // OAuth discovery for MCP clients (ADR-023): the issuer is PUBLIC_URL,
      // which is this origin in development.
      "/.well-known": "http://localhost:3000",
      // The GitHub App's Setup URL (M2-02): GitHub sends the browser to
      // PUBLIC_URL, this origin in development.
      "/setup/github": "http://localhost:3000",
    },
  },
  test: {
    // Capped so several agents testing at once cannot exhaust a
    // workstation's RAM (apps/api/vitest.config.ts says why).
    maxWorkers,
    // The dev mock backend, the dictionaries and the component gallery are
    // data or development screens, not code a test should be asked to reach.
    coverage: {
      ...coverage,
      exclude: [...coverage.exclude, "src/mock/**", "src/i18n/en.ts", "src/i18n/fr.ts", "src/DevGallery.tsx"],
    },
    // Vitest 4 removed `environmentMatchGlobs`; test projects are its
    // replacement. Two of them, so the pure-logic suite keeps running in
    // `node` (fast, no DOM to boot) while the component suite gets jsdom,
    // and the jsdom setup file never runs for the node tests.
    // `extends: true` reuses this very file, plugins included, so React and
    // `import.meta.glob` (help.tsx) transform the same way in both.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
          // Every test gets a clean fetch stub and clean spies.
          restoreMocks: true,
          // The first mount of a screen pulls its lazy chunks (the rich
          // editor alone is Tiptap + KaTeX): under a full parallel run that
          // takes the default 5 s on a loaded worker, and a test that fails
          // only when the machine is busy is a test nobody trusts.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
