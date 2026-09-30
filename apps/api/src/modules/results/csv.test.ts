import { describe, expect, it } from "vitest";

import { csvFilename } from "./csv.js";

describe("csvFilename", () => {
  it("is the title's slug: accents folded, lower case, single dashes, capped", () => {
    expect(csvFilename("Test 0 — Bases du C (été)")).toBe("test-0-bases-du-c-ete.csv");
    expect(csvFilename("x".repeat(80))).toBe(`${"x".repeat(60)}.csv`);
  });

  it("falls back to `results` when the title has no usable character", () => {
    expect(csvFilename("—?!")).toBe("results.csv");
  });
});
