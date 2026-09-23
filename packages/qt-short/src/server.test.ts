/** The contract surface of `shortServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
import { emptyShortDraft, ShortConfigSchema } from "./schema.js";
import { expectedAnswers, migrateShortV1, shortServer } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(shortServer.id).toBe("short");
    expect(shortServer.configVersion).toBe(2);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(shortServer.emptyDraft().prompt).toBe("");
    expect(shortServer.configSchema.safeParse(shortServer.emptyDraft()).success).toBe(false);
  });

  it("migrates a v2 config by identity, invalid draft included (D16)", () => {
    const cfg = emptyShortDraft();
    expect(shortServer.migrate(cfg, 2)).toBe(cfg);
  });

  it("refuses a version it never emitted", () => {
    expect(() => shortServer.migrate(emptyShortDraft(), 0)).toThrow(ConfigMigrationError);
    expect(() => shortServer.migrate(emptyShortDraft(), 3)).toThrow(ConfigMigrationError);
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

/**
 * The v1 -> v2 move: the three text flags leave the matchers and the two
 * prefilters are read off the FIRST exact matcher.
 */
describe("migrate v1 -> v2", () => {
  const v1 = (matchers: unknown[], over: Record<string, unknown> = {}) => ({
    configVersion: 1,
    prompt: "Give the directive.",
    kind: "text",
    matchers,
    ...over,
  });

  it("lifts the flags of the first exact matcher onto the question", () => {
    const out = migrateShortV1(
      v1([{ kind: "exact", value: "Newton", caseSensitive: true, trim: false, collapseSpaces: true }]),
    );
    expect(out.configVersion).toBe(2);
    expect(out.prefilters).toEqual({ trim: false, lowercase: false });
    expect(out.matchers).toEqual([{ kind: "exact", value: "Newton" }]);
    expect(ShortConfigSchema.safeParse(out).success).toBe(true);
  });

  it("defaults both prefilters to on when nothing says otherwise", () => {
    const out = migrateShortV1(v1([{ kind: "exact", value: "const" }]));
    expect(out.prefilters).toEqual({ trim: true, lowercase: true });
    expect(out.constraints).toEqual({ minLength: 0, maxLength: 255, integer: false });
  });

  it("reads the FIRST exact matcher and strips the flags off every one", () => {
    const out = migrateShortV1(
      v1([
        { kind: "regex", pattern: "a+", flags: "i" },
        { kind: "exact", value: "a", caseSensitive: true },
        { kind: "exact", value: "b", caseSensitive: false, trim: true, collapseSpaces: false },
      ]),
    );
    expect(out.prefilters).toEqual({ trim: true, lowercase: false });
    expect(out.matchers).toEqual([
      { kind: "regex", pattern: "a+", flags: "i" },
      { kind: "exact", value: "a" },
      { kind: "exact", value: "b" },
    ]);
  });

  it("keeps a question with no exact matcher on the defaults", () => {
    const out = migrateShortV1(
      v1([{ kind: "number", value: 5, tolerance: 0 }], { kind: "number", placeholder: "octets" }),
    );
    expect(out.prefilters).toEqual({ trim: true, lowercase: true });
    expect(out.kind).toBe("number");
    expect(out.placeholder).toBe("octets");
    expect(ShortConfigSchema.safeParse(out).success).toBe(true);
  });

  it("is what the type exposes as its migration", () => {
    const source = v1([{ kind: "exact", value: "const", caseSensitive: true }]);
    expect(shortServer.migrate(source, 1)).toEqual(migrateShortV1(source));
  });

  it("migrates an invalid v1 draft without throwing (D16)", () => {
    const out = migrateShortV1({ configVersion: 1, prompt: "", matchers: [] });
    expect(out.configVersion).toBe(2);
    expect(ShortConfigSchema.safeParse(out).success).toBe(false);
  });
});

describe("the canonical mapping", () => {
  it("round-trips every matcher kind", () => {
    expect(fromCanonical(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });

  it("writes the constraints and the prefilters only when they left their default", () => {
    expect(toCanonical(SECRET_CONFIG)).toMatchObject({
      constraints: { min: 1, max: 100, integer: true },
      prefilters: { lowercase: false },
    });
    expect(toCanonical(config())).not.toHaveProperty("constraints");
    expect(toCanonical(config())).not.toHaveProperty("prefilters");
  });

  it("omits the defaults", () => {
    expect(toCanonical(emptyShortDraft())).toEqual({
      configVersion: 2,
      prompt: "",
      matchers: [{ kind: "exact", value: "" }],
    });
  });

  it("is what the type exposes to the exporter", () => {
    expect(shortServer.toCanonical?.(SECRET_CONFIG)).toEqual(toCanonical(SECRET_CONFIG));
    expect(shortServer.fromCanonical?.(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });
});

describe("summarizeAnswer — the glyph of the live grid (F-DASH-02)", () => {
  const summarize = (text: string) => shortServer.summarizeAnswer!(config(), { text });

  it("is what the student typed", () => {
    expect(summarize("malloc")).toBe("malloc");
  });

  it("collapses the whitespace, so a pasted newline cannot break the row", () => {
    expect(summarize("  int\n  main ")).toBe("int main");
  });

  it("is empty for an empty field, and says nothing about the verdict", () => {
    expect(summarize("   ")).toBe("");
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
