/** The contract surface of `clozeServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./fixtures.js";
import { ClozeConfigSchema, emptyClozeDraft } from "./schema.js";
import { clozeServer, hasSelectBlank } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(clozeServer.id).toBe("cloze");
    expect(clozeServer.configVersion).toBe(1);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(clozeServer.emptyDraft().text).toBe("");
    expect(clozeServer.configSchema.safeParse(clozeServer.emptyDraft()).success).toBe(false);
  });

  it("migrates a v1 config by identity", () => {
    const cfg = emptyClozeDraft();
    expect(clozeServer.migrate(cfg, 1)).toBe(cfg);
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
    expect(solution.blanks.at(-1)).toEqual({ index: 4, expected: "/^N$/" });
  });

  it("indexes the authoring text for the teacher's search", () => {
    expect(clozeServer.searchText(SECRET_CONFIG)).toBe(SECRET_CONFIG.text);
  });
});

describe("the canonical mapping", () => {
  it("round-trips a full config", () => {
    const cfg = config("{{=a|b}}", { caseSensitive: true, shuffleOptions: false });
    expect(fromCanonical(toCanonical(cfg))).toEqual(cfg);
  });

  it("omits the defaults", () => {
    expect(toCanonical(emptyClozeDraft())).toEqual({
      configVersion: 1,
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
    for (const file of ["server.ts", "schema.ts", "grade.ts", "canonical.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "react/);
      expect(source).not.toMatch(/@quiz\/core\/client/);
    }
  });
});
