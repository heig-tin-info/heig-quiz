/**
 * Guard rail of the answer key (`QuestionTypeClient.Key`, ADR-109): it is
 * STAFF ONLY. A type's key draws the solution the per-question view serves
 * the course's staff, which never goes through `toStudent` (invariant 4), so
 * it must never be mounted on a student surface.
 *
 * It reads source text, as `ui/controlsGuard.test.ts` does: one module of
 * the app reads a type's `Key`, only the two staff screens of the debrief
 * import it, and nothing outside `results/` imports it but the router, whose
 * routes to it are staff ones. Static and dynamic imports alike.
 * Comments are blanked first; tests are not scanned.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** An import of `spec`, static (`from "…"`) or dynamic (`import("…")`). */
const imports = (spec: string) => new RegExp(`(from\\s+|import\\()\\s*"${spec}"`);

const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .map((entry) => entry.split("\\").join("/"))
  .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry))
  .map((path) => ({
    path,
    // Comments blanked, so a sentence about `QuestionTypeClient.Key` is not a read.
    src: readFileSync(join(SRC, path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"),
  }));

describe("the answer key is staff only (ADR-109)", () => {
  it("scans the app", () => {
    expect(files.some((f) => f.path === "results/CorrectionQuestion.tsx")).toBe(true);
    expect(files.some((f) => f.path === "App.tsx")).toBe(true);
  });

  it("is read by one module of the app, the debrief's", () => {
    const readers = files.filter((f) => /\.Key\b|\{[^}]*\bKey\b[^}]*\}\s*=/.test(f.src)).map((f) => f.path);
    expect(readers).toEqual(["results/CorrectionQuestion.tsx"]);
  });

  it("is mounted by the correction projection and the Results Questions tab only", () => {
    const importers = files.filter((f) => imports("[./]*(results/)?CorrectionQuestion").test(f.src)).map((f) => f.path);
    expect(importers.sort()).toEqual(["results/ByQuestionView.tsx", "results/CorrectionProjection.tsx"]);
  });

  it("is out of reach of every student surface: only the router imports results/", () => {
    const importers = files
      .filter((f) => !f.path.startsWith("results/"))
      .filter((f) => imports("[./]*/?results/[^\"]*").test(f.src))
      .map((f) => f.path);
    expect(importers).toEqual(["App.tsx"]);
  });
});
