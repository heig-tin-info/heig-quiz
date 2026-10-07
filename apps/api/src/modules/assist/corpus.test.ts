import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildCorpus } from "@quiz/domain";

import { loadCorpus, readCorpusSources } from "./corpus.js";

const dir = mkdtempSync(join(tmpdir(), "assist-corpus-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the assistant's corpus (ADR-080 §5)", () => {
  it("reads the repository's guide and help, the French topics beside the English ones", () => {
    const sources = readCorpusSources();
    expect(sources.some((s) => s.id === "guide/pools" && s.locale === "en")).toBe(true);
    expect(sources.some((s) => s.id === "help/pool" && s.locale === "fr")).toBe(true);
    const corpus = buildCorpus(sources);
    expect(corpus.pages.find((p) => p.id === "guide/admin")?.audience).toBe("admin");
  });

  it("refuses a checkout without the guide: a build must not ship an empty assistant", () => {
    expect(() => readCorpusSources(dir)).toThrow(/missing/);
  });

  it("skips a help file that is not a topic", () => {
    mkdirSync(join(dir, "docs/guide"), { recursive: true });
    mkdirSync(join(dir, "apps/web/src/help"), { recursive: true });
    writeFileSync(join(dir, "docs/guide/index.md"), "# Overview\n");
    writeFileSync(join(dir, "apps/web/src/help/pool.md"), "# Pool\n");
    writeFileSync(join(dir, "apps/web/src/help/README.txt.md"), "# not a topic\n");
    expect(readCorpusSources(dir).map((s) => s.id)).toEqual(["guide/index", "help/pool"]);
  });

  it("loads the build's artifact first; without it, builds from the repository outside production only", () => {
    const artifact = join(dir, "assist-corpus.json");
    expect(loadCorpus(true, artifact)).toBeNull();
    expect(loadCorpus(false, artifact)?.pages.length).toBeGreaterThan(10);
    writeFileSync(artifact, JSON.stringify({ version: "v1", pages: [] }));
    expect(loadCorpus(true, artifact)).toEqual({ version: "v1", pages: [] });
  });
});
