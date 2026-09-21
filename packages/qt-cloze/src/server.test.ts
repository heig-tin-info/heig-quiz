/** The contract surface of `clozeServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./fixtures.js";
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
   * v1 is v2 with no predefined choice set: nothing in a v1 text can name one,
   * so the list is empty and every blank keeps the kind it already had.
   */
  it("migrates a v1 config by adding an empty list of choice sets", () => {
    const v1 = { configVersion: 1, text: "{{a}}", caseSensitive: false, shuffleOptions: true };
    const migrated = clozeServer.migrate(v1, 1);
    expect(migrated).toEqual({ ...v1, configVersion: CLOZE_CONFIG_VERSION, choiceSets: [] });
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
    // A set-backed dropdown names its set and lays the list out for the panel.
    expect(solution.blanks.at(-1)).toEqual({
      index: 5,
      expected: "set SET-KEY-MARKER (newton ✓, pascal, joule)",
    });
  });

  it("indexes the authoring text AND the labels of the choice sets", () => {
    const indexed = clozeServer.searchText(SECRET_CONFIG);
    expect(indexed).toContain(SECRET_CONFIG.text);
    // `{{SET-KEY-MARKER}}` holds none of its options: "pascal" must still find it.
    expect(indexed).toContain("pascal");
  });
});

describe("the canonical mapping", () => {
  it("round-trips a full config, choice sets included", () => {
    const cfg = config("{{=a|b}} {{k}}", {
      caseSensitive: true,
      shuffleOptions: false,
      choiceSets: [
        { key: "k", options: [{ label: "a", correct: true }, { label: "b", correct: false }] },
      ],
    });
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

describe("the server entry point", () => {
  it("never reaches React", () => {
    for (const file of ["server.ts", "schema.ts", "grade.ts", "canonical.ts", "parse.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "react/);
      expect(source).not.toMatch(/@quiz\/core\/client/);
    }
  });
});
