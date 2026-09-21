/** The contract surface of `shortServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./fixtures.js";
import { emptyShortDraft, ShortConfigSchema } from "./schema.js";
import { expectedAnswers, shortServer } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(shortServer.id).toBe("short");
    expect(shortServer.configVersion).toBe(1);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(shortServer.emptyDraft().prompt).toBe("");
    expect(shortServer.configSchema.safeParse(shortServer.emptyDraft()).success).toBe(false);
  });

  it("migrates a v1 config by identity", () => {
    const cfg = emptyShortDraft();
    expect(shortServer.migrate(cfg, 1)).toBe(cfg);
  });

  it("refuses a version it never emitted", () => {
    expect(() => shortServer.migrate(emptyShortDraft(), 0)).toThrow(ConfigMigrationError);
  });

  it("defaults an item to one point and is never shuffleable", () => {
    expect(shortServer.defaultPoints(config())).toBe(1);
    expect(shortServer.shuffleable(config())).toBe(false);
  });

  it("renders the key for the teacher, one line per matcher", () => {
    expect(shortServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: false })).toEqual({
      expected: expectedAnswers(SECRET_CONFIG),
    });
    expect(expectedAnswers(SECRET_CONFIG)).toContain("4 ± 0.5 bytes");
  });

  it("indexes the prompt and the expected answers for the teacher's search", () => {
    const text = shortServer.searchText(SECRET_CONFIG);
    expect(text).toContain("32-bit");
    expect(text).toContain("0x1004");
  });
});

describe("the canonical mapping", () => {
  it("round-trips every matcher kind", () => {
    expect(fromCanonical(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });

  it("omits the defaults", () => {
    expect(toCanonical(emptyShortDraft())).toEqual({
      configVersion: 1,
      prompt: "",
      matchers: [{ kind: "exact", value: "" }],
    });
  });

  it("is what the type exposes to the exporter", () => {
    expect(shortServer.toCanonical?.(SECRET_CONFIG)).toEqual(toCanonical(SECRET_CONFIG));
    expect(shortServer.fromCanonical?.(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
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
