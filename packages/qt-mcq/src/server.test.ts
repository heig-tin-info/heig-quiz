/**
 * The contract surface of `mcqServer`: what the API calls on every read, every
 * write and every publication.
 */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { fromCanonical, toCanonical } from "./canonical.js";
import { multipleConfig, SECRET_CONFIG } from "./test/fixtures.js";
import { MCQ_CONFIG_VERSION, McqConfigSchema, emptyMcqDraft } from "./schema.js";
import { choiceOrder, mcqServer } from "./server.js";

describe("the contract", () => {
  it("is registered under its own id and version", () => {
    expect(mcqServer.id).toBe("mcq");
    expect(mcqServer.configVersion).toBe(MCQ_CONFIG_VERSION);
    expect(MCQ_CONFIG_VERSION).toBe(2);
  });

  it("emits an EMPTY draft, stored as it stands (D16)", () => {
    expect(mcqServer.emptyDraft().prompt).toBe("");
    expect(mcqServer.configSchema.safeParse(mcqServer.emptyDraft()).success).toBe(false);
  });

  it("returns a config already at the current version as it stands (D16)", () => {
    const config = emptyMcqDraft();
    expect(mcqServer.migrate(config, MCQ_CONFIG_VERSION)).toBe(config);
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
    const config = multipleConfig({
      policy: "discordance",
      maxSelections: 3,
      shuffleChoices: false,
    });
    expect(fromCanonical(toCanonical(config))).toEqual(config);
  });

  it("round-trips a question that inherits its policy", () => {
    const config = multipleConfig({ policy: "inherit" });
    expect(toCanonical(config)).not.toHaveProperty("policy");
    expect(fromCanonical(toCanonical(config))).toEqual(config);
  });

  it("omits the defaults, so the YAML reads like the spec example", () => {
    const canonical = toCanonical(emptyMcqDraft());
    expect(canonical).toEqual({
      configVersion: MCQ_CONFIG_VERSION,
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

describe("the v1 -> v2 migration", () => {
  /** A v1 config, exactly as the column stored it before the bump. */
  const v1 = (over: Record<string, unknown> = {}) => ({
    configVersion: 1,
    prompt: "Which declarations are valid?",
    choices: [
      { text: "a", correct: true },
      { text: "b", correct: true },
      { text: "c", correct: false },
    ],
    mode: "multiple",
    policy: "all_or_nothing",
    penalty: 1,
    allowNegative: false,
    shuffleChoices: true,
    ...over,
  });

  const migrated = (over: Record<string, unknown> = {}) => mcqServer.migrate(v1(over), 1);

  it("maps partial and penalized onto symmetric, the closest of the five", () => {
    expect(migrated({ policy: "partial" }).policy).toBe("symmetric");
    expect(migrated({ policy: "penalized", penalty: 0.5 }).policy).toBe("symmetric");
  });

  it("leaves all_or_nothing alone", () => {
    expect(migrated().policy).toBe("all_or_nothing");
  });

  it("drops penalty and allowNegative, and bumps the version", () => {
    const config = migrated({ policy: "penalized", penalty: 0.25, allowNegative: true });
    expect(config).not.toHaveProperty("penalty");
    expect(config).not.toHaveProperty("allowNegative");
    expect(config.configVersion).toBe(MCQ_CONFIG_VERSION);
  });

  it("keeps everything else, and the result parses", () => {
    const config = migrated({ policy: "partial", maxSelections: 2 });
    expect(config.prompt).toBe("Which declarations are valid?");
    expect(config.choices).toHaveLength(3);
    expect(config.mode).toBe("multiple");
    expect(McqConfigSchema.safeParse(config).success).toBe(true);
  });

  it("is total: a row with an unreadable policy still comes out valid", () => {
    expect(migrated({ policy: "whatever" }).policy).toBe("all_or_nothing");
    expect((mcqServer.migrate({}, 1) as { policy: string }).policy).toBe("all_or_nothing");
  });
});

describe("summarizeAnswer — the glyph of the live grid (F-DASH-02)", () => {
  const summarize = (selected: number[]) =>
    mcqServer.summarizeAnswer!(multipleConfig(), { selected });

  it("writes the letters of the canonical positions", () => {
    expect(summarize([0, 2])).toBe("A, C");
  });

  it("sorts them, so two students who ticked the same pair read the same", () => {
    expect(summarize([3, 1])).toBe("B, D");
    expect(summarize([1, 3])).toBe(summarize([3, 1]));
  });

  it("is empty when nothing is ticked, and never says whether it is right", () => {
    expect(summarize([])).toBe("");
    expect(summarize([1])).not.toMatch(/correct|wrong/i);
  });

  it("ignores an index the config no longer has", () => {
    expect(summarize([0, 99])).toBe("A");
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
