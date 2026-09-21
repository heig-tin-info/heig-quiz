/**
 * The contract surface of `mcqServer`: what the API calls on every read, every
 * write and every publication.
 */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { multipleConfig, SECRET_CONFIG } from "./fixtures.js";
import { McqConfigSchema, emptyMcqDraft } from "./schema.js";
import { choiceOrder, mcqServer } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(mcqServer.id).toBe("mcq");
    expect(mcqServer.configVersion).toBe(1);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(mcqServer.emptyDraft().prompt).toBe("");
    expect(mcqServer.configSchema.safeParse(mcqServer.emptyDraft()).success).toBe(false);
  });

  it("migrates a v1 config by identity", () => {
    const config = emptyMcqDraft();
    expect(mcqServer.migrate(config, 1)).toBe(config);
  });

  it("refuses a version it never emitted", () => {
    expect(() => mcqServer.migrate(emptyMcqDraft(), 0)).toThrow(ConfigMigrationError);
  });

  it("defaults an item to one point", () => {
    expect(mcqServer.defaultPoints(emptyMcqDraft())).toBe(1);
  });

  it("is shuffleable only when the config asks for it", () => {
    expect(mcqServer.shuffleable(multipleConfig())).toBe(true);
    expect(mcqServer.shuffleable(multipleConfig({ shuffleChoices: false }))).toBe(false);
  });

  it("feeds the search index with the prompt and every choice", () => {
    const text = mcqServer.searchText(SECRET_CONFIG);
    expect(text).toContain("p + 1");
    expect(text).toContain("0x1004");
  });

  it("hands the key to the feedback path, and only there", () => {
    expect(mcqServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: true })).toEqual({
      correct: [1],
    });
  });
});

describe("the canonical mapping", () => {
  it("round-trips a full config", () => {
    const config = multipleConfig({ maxSelections: 3, allowNegative: true, shuffleChoices: false });
    expect(fromCanonical(toCanonical(config))).toEqual(config);
  });

  it("omits the defaults, so the YAML reads like the spec example", () => {
    const canonical = toCanonical(emptyMcqDraft());
    expect(canonical).toEqual({
      configVersion: 1,
      prompt: "",
      choices: [{ text: "", correct: true }, { text: "" }],
    });
  });

  it("is what the type exposes to the exporter", () => {
    expect(mcqServer.toCanonical?.(SECRET_CONFIG)).toEqual(toCanonical(SECRET_CONFIG));
    expect(mcqServer.fromCanonical?.(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });
});

describe("the shuffle", () => {
  const view = { seed: 4242, itemId: "item-1", shuffle: true };

  it("is stable for one (seed, item): a reload shows the same order", () => {
    expect(choiceOrder(SECRET_CONFIG, view)).toEqual(choiceOrder(SECRET_CONFIG, view));
  });

  it("is the canonical order when either switch is off", () => {
    expect(choiceOrder(SECRET_CONFIG, { ...view, shuffle: false })).toEqual([0, 1, 2]);
    expect(
      choiceOrder(McqConfigSchema.parse({ ...SECRET_CONFIG, shuffleChoices: false }), view),
    ).toEqual([0, 1, 2]);
  });

  it("is a permutation, never a loss", () => {
    const order = choiceOrder(SECRET_CONFIG, view);
    expect([...order].sort()).toEqual([0, 1, 2]);
  });

  it("differs from one attempt seed to another", () => {
    const orders = new Set(
      Array.from({ length: 24 }, (_, seed) =>
        choiceOrder(SECRET_CONFIG, { ...view, seed }).join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("the server entry point", () => {
  /**
   * `@quiz/qt-mcq/server` is loaded by the API and by the grading worker: React
   * must not appear anywhere in its import graph (PLAN-MVP §1, invariant of
   * `packages/core`). The check is on the source, so it fails at the moment the
   * mistake is written rather than at the moment the API bundle grows.
   */
  it("never reaches React", () => {
    for (const file of ["server.ts", "schema.ts", "grade.ts", "canonical.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "react/);
      expect(source).not.toMatch(/@quiz\/core\/client/);
    }
  });
});
