import { CRITERIA_SCHEMA_ID, RESULTS_SCHEMA_ID, checkOutcomes } from "@quiz/domain";
import { parseCriteria } from "@quiz/domain/criteriaParse";
import { describe, expect, it } from "vitest";

import { CheckScore, CriteriaFile3, ResultsFile, publishedSchemas } from "./checkResults.js";

const VALID_RESULTS = {
  $schema: RESULTS_SCHEMA_ID,
  criteria: {
    "code.format": { score: "1/1", log: "formatted" },
    "tests.functional": { score: "7.5/10", duration: 3 },
    "not.a.criterion": { score: "1/1" },
  },
  tool: "StudentScore 1.0",
};

/** A criteria file as data: JSON is YAML, so the parser reads its `JSON.stringify`. */
const VALID_CRITERIA = {
  schema_version: 3,
  grading: { context: "A first-year C lab.", sources: ["src/", "README.md"] },
  criteria: {
    code: { description: "The code", format: { description: "Formatted", max_points: 1, command: ["make", "format-check", ""] } },
    tests: {
      functional: { desc: "Functional tests", max_points: 10, command: ["make", "test"], milestone: "mid", awarded_points: 4 },
      crash: { description: "Crashes", max_points: -2, prompt: "Does it crash?" },
    },
    bonus: { fast: { description: "Fast", bonus_points: 0.5, command: ["./bench"] } },
    git: { history: { description: "Commit history", max_points: 2 } },
  },
};
type CriteriaData = typeof VALID_CRITERIA & Record<string, unknown>;
const variant = (change: (file: CriteriaData) => void): Record<string, unknown> => {
  const file = structuredClone(VALID_CRITERIA) as CriteriaData;
  change(file);
  return file;
};

describe("results.json (results-1)", () => {
  it("takes a valid file, ignoring unknown keys and ids, and maps it onto the criteria", () => {
    const file = ResultsFile.parse(VALID_RESULTS);
    const parsed = parseCriteria(JSON.stringify(VALID_CRITERIA), { version: 3 });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(checkOutcomes(parsed.criteria.leaves, file)).toEqual([
      { id: "code.format", points: 1, max: 1, log: "formatted" },
      { id: "tests.functional", points: 7.5, max: 10, log: null },
      { id: "bonus.fast", reason: "no_result" },
    ]);
  });

  it("refuses an invalid file, never for the length of a log", () => {
    for (const bad of [
      {},
      { criteria: { a: { score: "1/0" } } },
      { criteria: { a: { score: "0/0.0" } } },
      { criteria: { a: { score: "-1/2" } } },
      { criteria: { a: { score: 1 } } },
      { criteria: { a: {} } },
      { criteria: { a: { score: "1/1", log: 3 } } },
      { criteria: { "a b": { score: "1/1" } } },
      { criteria: { "a..b": { score: "1/1" } } },
    ]) {
      expect(ResultsFile.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ResultsFile.safeParse({ criteria: { a: { score: "1/1", log: "x".repeat(100_000) } } }).success).toBe(true);
    expect(CheckScore.safeParse(" 7.5 / 10 ").success).toBe(true);
  });
});

describe("criteria.yml (criteria-3)", () => {
  it("states the structure the parser reads: a valid file passes both, an invalid one neither", () => {
    expect(parseCriteria(JSON.stringify(VALID_CRITERIA), { version: 3 }).ok).toBe(true);
    expect(CriteriaFile3.safeParse(VALID_CRITERIA).success).toBe(true);
    const invalid: [string, (file: CriteriaData) => void][] = [
      ["a shell string", (f) => void ((f.criteria.tests.functional as Record<string, unknown>).command = "make test")],
      ["an empty program", (f) => void (f.criteria.tests.functional.command = ["", "test"])],
      ["schema 2's test", (f) => void ((f.criteria.git.history as Record<string, unknown>).test = "x")],
      ["a negative bonus", (f) => void (f.criteria.bonus.fast.bonus_points = -0.5)],
      ["a spaced name", (f) => void ((f.criteria as Record<string, unknown>)["g it"] = f.criteria.git)],
      ["a wildcard source", (f) => void (f.grading.sources = ["*.c"])],
      ["a percentage", (f) => void ((f.criteria.tests.functional as Record<string, unknown>).max_points = "50%")],
      ["schema 4", (f) => void ((f as Record<string, unknown>).schema_version = 4)],
      ["a prompt without points", (f) => void (f.criteria.git.history = { description: "Commit history", prompt: "Good?" } as never)],
    ];
    for (const [name, change] of invalid) {
      const file = variant(change);
      expect(parseCriteria(JSON.stringify(file), { version: 3 }).ok, name).toBe(false);
      expect(CriteriaFile3.safeParse(file).success, name).toBe(false);
    }
  });
});

describe("the published schemas", () => {
  const schemas = publishedSchemas() as Record<string, Record<string, unknown>>;

  it("carry their $id and the draft they follow", () => {
    expect(Object.keys(schemas).sort()).toEqual(["criteria-3.json", "results-1.json"]);
    expect(schemas["results-1.json"]!.$id).toBe("https://quiz.chevallier.io/schemas/results-1.json");
    expect(schemas["criteria-3.json"]!.$id).toBe(CRITERIA_SCHEMA_ID);
    for (const schema of Object.values(schemas)) expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("say what the validators say: the score pattern, the command's bounds, the loose results entries", () => {
    const results = schemas["results-1.json"]! as { properties: { criteria: { additionalProperties: Record<string, never> } } };
    const entry = results.properties.criteria.additionalProperties as unknown as { properties: { score: { pattern: string } }; additionalProperties: unknown };
    const pattern = new RegExp(entry.properties.score.pattern);
    expect(["1/1", " 7.5 / 10 ", "0/0.5"].every((s) => pattern.test(s))).toBe(true);
    expect(["1/0", "0/0.00", "-1/2"].some((s) => pattern.test(s))).toBe(false);
    expect(entry.additionalProperties).toEqual({});
    expect(JSON.stringify(schemas["criteria-3.json"])).toContain('"maxItems":20');
  });
});
