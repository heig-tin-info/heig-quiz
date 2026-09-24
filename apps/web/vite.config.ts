import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    },
  },
  test: {
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
