/** The contract surface of `clozeServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, emptyClozeDraft } from "./schema.js";
import { clozeServer, hasSelectBlank } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(clozeServer.id).toBe("cloze");
    expect(clozeServer.configVersion).toBe(CLOZE_CONFIG_VERSION);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(clozeServer.emptyDraft().text).toBe("");
    expect(clozeServer.configSchema.safeParse(clozeServer.emptyDraft()).success).toBe(false);
  });

  it("migrates the current version by identity (D16)", () => {
    const cfg = emptyClozeDraft();
    expect(clozeServer.migrate(cfg, CLOZE_CONFIG_VERSION)).toBe(cfg);
  });

  /*
   * v1 → v2 is the identity plus the version stamp: the two shapes are the
   * same (schema.ts says why the number moved anyway).
   */
  it("migrates a v1 config by stamping the version, changing nothing else", () => {
    const v1 = { configVersion: 1, text: "{{a}}", caseSensitive: false, shuffleOptions: true };
    const migrated = clozeServer.migrate(v1, 1);
    expect(migrated).toEqual({ ...v1, configVersion: CLOZE_CONFIG_VERSION });
    expect(ClozeConfigSchema.safeParse(migrated).success).toBe(true);
  });

  it("refuses a version it never emitted", () => {
    expect(() => clozeServer.migrate(emptyClozeDraft(), 0)).toThrow(ConfigMigrationError);
  });

  it("defaults to one point per blank", () => {
    expect(clozeServer.defaultPoints(config("{{a}} {{b}} {{c}}"))).toBe(3);
    expect(clozeServer.defaultPoints(emptyClozeDraft())).toBe(1);
  });

  it("is shuffleable only when a dropdown is there to shuffle", () => {
    expect(clozeServer.shuffleable(config("{{=a|b}}"))).toBe(true);
    expect(clozeServer.shuffleable(config("{{a}}"))).toBe(false);
    expect(clozeServer.shuffleable(config("{{=a|b}}", { shuffleOptions: false }))).toBe(false);
    expect(hasSelectBlank(SECRET_CONFIG)).toBe(true);
  });

  it("renders the key blank by blank for the feedback path", () => {
    const solution = clozeServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: true });
    expect(solution.blanks[0]).toEqual({ index: 0, expected: "Newton | newton" });
    expect(solution.blanks[4]).toEqual({ index: 4, expected: "/^N$/" });
    // A dropdown lists the CORRECT labels, and only those.
    expect(solution.blanks.at(-1)).toEqual({ index: 5, expected: "NEWTON-MARKER" });
  });

  it("indexes the authoring text, which holds every answer a cloze has", () => {
    const indexed = clozeServer.searchText(SECRET_CONFIG);
    expect(indexed).toContain(SECRET_CONFIG.text);
    expect(indexed).toContain("pascal");
  });
});

describe("the canonical mapping", () => {
  it("round-trips a full config", () => {
    const cfg = config("{{=a|b}} {{k}}", { caseSensitive: true, shuffleOptions: false });
    expect(fromCanonical(toCanonical(cfg))).toEqual(cfg);
  });

  it("omits the defaults", () => {
    expect(toCanonical(emptyClozeDraft())).toEqual({
      configVersion: CLOZE_CONFIG_VERSION,
      text: "",
    });
  });

  it("is what the type exposes to the exporter", () => {
    expect(clozeServer.toCanonical?.(SECRET_CONFIG)).toEqual(toCanonical(SECRET_CONFIG));
    expect(clozeServer.fromCanonical?.(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });
});

describe("summarizeAnswer — the glyph of the live grid (F-DASH-02)", () => {
  const text = "Un {{int}} tient {{=32|64}} bits sur {{cette|la}} machine.";
  const summarize = (blanks: (string | null)[]) =>
    clozeServer.summarizeAnswer!(config(text), { blanks });

  it("joins the blanks in order", () => {
    expect(summarize(["int", "0", "cette"])).toBe("int · 32 · cette");
  });

  it("resolves a dropdown back to its label, never its stored index (D4)", () => {
    expect(summarize([null, "1", null])).toBe("— · 64 · —");
  });

  it("keeps an untouched blank as a dash, because the position is the point", () => {
    expect(summarize(["int", null, null])).toBe("int · — · —");
  });

  it("says nothing about whether any blank is right", () => {
    expect(summarize(["float", "0", "la"])).toBe("float · 32 · la");
  });
});

describe("the server entry point", () => {
  it("never reaches React", () => {
    for (const file of ["server.ts", "schema.ts", "grade.ts", "canonical.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "react/);
      expect(source).not.toMatch(/@quiz\/core\/client/);
    }
  });
});
