import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkFraction, checkPoints, classifyCriterion, criteriaTotals, parseCheckScore, roundPoints, type ParsedCriteria } from "./criteria.js";
import { parseCriteria, type CriteriaParse } from "./criteriaParse.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/criteria/${name}`, import.meta.url), "utf8");

function parsed(text: string): ParsedCriteria {
  const result = parseCriteria(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.criteria;
}

function errors(text: string): CriteriaParse & { ok: false } {
  const result = parseCriteria(text);
  if (result.ok) throw new Error("parsed");
  return result;
}

const item = (extra: string) => `schema_version: 3\ncriteria:\n  s:\n    c:\n      description: d\n${extra}`;
const leafOf = (extra: string) => parsed(item(extra)).leaves[0]!;
const refusalsOf = (extra: string) => errors(item(extra)).errors;

/** Labo 00 moved to schema 3: its `awarded_points` stay (ignored), its tests criterion gets a check. */
const LABO_00_V3 = fixture("labo-00-revised.yml")
  .replace("schema_version: 2", "schema_version: 3")
  .replace("      max_points: 12\n", "      max_points: 12\n      command: [python3, -m, pytest, -q]\n");

describe("parseCriteria, schema 3, on labo 00", () => {
  it("reads seven criteria, 20 points, a penalty, a bonus and a check", () => {
    const criteria = parsed(LABO_00_V3);
    expect(criteria.schemaVersion).toBe(3);
    expect(criteria.leaves.map((l) => l.maxPoints)).toEqual([12, 4, 2, 1, -3, 1, 0]);
    expect(criteria.leaves[0]!.command).toEqual(["python3", "-m", "pytest", "-q"]);
    expect(criteria.leaves[6]).toMatchObject({ sectionPath: ["bonus"], bonusPoints: 1 });
    expect(criteria.grading.sources).toContain("build/rapport.md");
    expect(criteriaTotals(criteria.leaves, {})).toMatchObject({ max: 20, bonusMax: 1 });
  });

  it("classifies by the file alone: the check automatic, the rest by its prompt", () => {
    expect(parsed(LABO_00_V3).leaves.map((l) => classifyCriterion(l))).toEqual(["automatic", "llm", "llm", "llm", "llm", "llm", "llm"]);
  });
});

describe("classifyCriterion without the schema-2 settings", () => {
  it("makes a criterion with a command automatic, even with a prompt; a prompt the model's; neither the teacher's", () => {
    expect(classifyCriterion({ id: "a.b", command: ["make", "check"], prompt: "p" })).toBe("automatic");
    expect(classifyCriterion({ id: "a.b", command: ["make", "check"] })).toBe("automatic");
    expect(classifyCriterion({ id: "a.b", prompt: "p" })).toBe("llm");
    expect(classifyCriterion({ id: "a.b" })).toBe("teacher");
    expect(classifyCriterion({ id: "a.b", test: "test_x", prompt: "p" })).toBe("llm");
  });
});

describe("a check's result", () => {
  it("reads n/m, decimal, spaces around each", () => {
    expect(parseCheckScore("7/10")).toEqual({ n: 7, m: 10 });
    expect(parseCheckScore(" 7.5 / 10 ")).toEqual({ n: 7.5, m: 10 });
    expect(parseCheckScore("\t3/2.5\n")).toEqual({ n: 3, m: 2.5 });
    expect(parseCheckScore("0/1")).toEqual({ n: 0, m: 1 });
    expect(parseCheckScore("1/0.5")).toEqual({ n: 1, m: 0.5 });
  });

  it("refuses a zero denominator, a sign, a bare number, an exponent and a dangling dot", () => {
    for (const bad of ["1/0", "0/0", "0/0.0", "1/00.00 ", "-1/2", "1/-2", "+1/2", "3", "1e2/3", "1./2", ".5/1", "1/2/3", "1 2/3", "", "a/b"]) {
      expect(parseCheckScore(bad), bad).toBeNull();
    }
  });

  it("clamps n into [0, m]", () => {
    expect(checkFraction({ n: 7.5, m: 10 })).toBe(0.75);
    expect(checkFraction({ n: 12, m: 10 })).toBe(1);
    expect(checkFraction({ n: 0, m: 3 })).toBe(0);
  });

  it("earns max × f, a penalty max × (1 − f), a bonus bonus × f", () => {
    expect(checkPoints({ maxPoints: 4 }, 0.75)).toBe(3);
    expect(checkPoints({ maxPoints: 4 }, 0)).toBe(0);
    expect(checkPoints({ maxPoints: -3 }, 1)).toBe(0);
    expect(checkPoints({ maxPoints: -3 }, 0)).toBe(-3);
    expect(checkPoints({ maxPoints: -3 }, 0.25)).toBe(-2.25);
    expect(checkPoints({ maxPoints: 0, bonusPoints: 2 }, 0.5)).toBe(1);
    expect(checkPoints({ maxPoints: 0, bonusPoints: 2 }, 0)).toBe(0);
  });

  it("clamps f into [0, 1] and rounds to 0.01, half away from zero", () => {
    expect(checkPoints({ maxPoints: 4 }, 2)).toBe(4);
    expect(checkPoints({ maxPoints: 4 }, -1)).toBe(0);
    expect(checkPoints({ maxPoints: 2 }, 1 / 3)).toBe(0.67);
    expect(checkPoints({ maxPoints: -3.5 }, 0.25)).toBe(-2.63);
    expect(checkPoints({ maxPoints: 7 }, checkFraction({ n: 7.5, m: 10 }))).toBe(5.25);
  });

  it("rounds negative halves away from zero, unlike Math.round", () => {
    expect(roundPoints(-2.625)).toBe(-2.63);
    expect(roundPoints(2.625)).toBe(2.63);
    expect(roundPoints(-0.005)).toBe(-0.01);
    expect(roundPoints(-2.624)).toBe(-2.62);
    expect(roundPoints(1.005)).toBe(1.01);
    expect(roundPoints(1.0049)).toBe(1);
    expect(Object.is(roundPoints(-0.004), 0)).toBe(true);
    expect(roundPoints(12)).toBe(12);
  });
});

describe("parseCriteria, schema 3", () => {
  it("reads a leaf's keys, ignoring awarded_points and rationale whatever they hold", () => {
    expect(leafOf("      max_points: 2.5\n      awarded_points: '50%'\n      rationale: [1]\n      milestone: mid-review\n      prompt: Is it right?\n")).toEqual({
      id: "s.c",
      sectionPath: ["s"],
      description: "d",
      maxPoints: 2.5,
      prompt: "Is it right?",
      milestone: "mid-review",
    });
  });

  it("takes a negative maximum as a penalty and a positive bonus", () => {
    expect(leafOf("      max_points: -2\n").maxPoints).toBe(-2);
    expect(leafOf("      bonus_points: 0.5\n")).toMatchObject({ maxPoints: 0, bonusPoints: 0.5 });
  });

  it("reads a command as its argv, later words possibly empty, with or without a prompt", () => {
    expect(leafOf("      max_points: 1\n      command: [make, check, 'a b; c']\n").command).toEqual(["make", "check", "a b; c"]);
    expect(leafOf("      max_points: 1\n      command: [printf, '']\n").command).toEqual(["printf", ""]);
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(leafOf(`      max_points: 1\n      prompt: p\n      command: [${words.join(", ")}]\n`)).toMatchObject({ command: words, prompt: "p" });
  });

  it("refuses a command that is no argv of 1 to 20 strings, the first non-empty, without NUL", () => {
    const bad = { path: "criteria/s/c/command", code: "bad_command", params: { max: 20 } };
    for (const command of ["make check", "[]", "['', x]", "[make, 3]", '[a, "b\\0c"]', `[${Array.from({ length: 21 }, () => "a").join(", ")}]`, "{a: b}", "~"]) {
      expect(refusalsOf(`      max_points: 1\n      command: ${command}\n`), command).toEqual([bad]);
    }
  });

  it("reads desc as description's short form, never both", () => {
    expect(parsed("schema_version: 3\ncriteria:\n  c: {desc: Short, max_points: 1}\n").leaves[0]!.description).toBe("Short");
    expect(errors("schema_version: 3\ncriteria:\n  c: {desc: a, description: b, max_points: 1}\n").errors).toEqual([
      { path: "criteria/c", code: "both_descriptions" },
    ]);
  });

  it("makes a mapping with any leaf key a leaf, so a missing maximum or description is named", () => {
    expect(errors("schema_version: 3\ncriteria:\n  c: {description: c, command: [make]}\n").errors).toEqual([{ path: "criteria/c", code: "missing_points" }]);
    expect(errors("schema_version: 3\ncriteria:\n  c: {max_points: 1}\n").errors).toEqual([{ path: "criteria/c", code: "missing_description" }]);
  });

  it("refuses an unknown top-level key", () => {
    expect(errors("schema_version: 3\nextra: 1\ncriteria:\n  c: {description: c, max_points: 1}\n").errors).toEqual([{ path: "extra", code: "unknown_key" }]);
  });

  it("names the path of each wrong criterion", () => {
    const text = [
      "schema_version: 3",
      "criteria:",
      "  s:",
      "    a.b: {max_points: 1, description: x}",
      "    a b: {max_points: 1, description: x}",
      "    c:",
      "      max_points: '50%'",
      "      test: tests/test_x.py",
      "    d: {description: d, max_points: 2, bonus_points: 1}",
      "    f: {description: f, max_points: 0}",
      "    g: {description: g, bonus_points: -1}",
      "    h: {description: h, max_points: true}",
    ].join("\n");
    expect(errors(text).errors).toEqual([
      { path: "criteria/s/a.b", code: "dotted_key" },
      { path: "criteria/s/a b", code: "spaced_key" },
      { path: "criteria/s/c/test", code: "unknown_key" },
      { path: "criteria/s/c", code: "missing_description" },
      { path: "criteria/s/c/max_points", code: "not_number" },
      { path: "criteria/s/d", code: "both_points" },
      { path: "criteria/s/f/max_points", code: "zero_points" },
      { path: "criteria/s/g/bonus_points", code: "negative_bonus" },
      { path: "criteria/s/h/max_points", code: "not_number" },
    ]);
  });

  it("takes plain sources only", () => {
    const grading = (block: string) => `schema_version: 3\ngrading:\n${block}\ncriteria:\n  c: {description: c, max_points: 1}\n`;
    expect(parsed(grading("  sources: [src/, report.md]")).grading.sources).toEqual(["src/", "report.md"]);
    expect(errors(grading("  sources: [src/, '*.md', 'a/b?.c', 'x[0]']")).errors).toEqual([
      { path: "grading/sources/1", code: "wildcard_source", params: { source: "*.md" } },
      { path: "grading/sources/2", code: "wildcard_source", params: { source: "a/b?.c" } },
      { path: "grading/sources/3", code: "wildcard_source", params: { source: "x[0]" } },
    ]);
    expect(errors(grading("  sources: a")).errors).toEqual([{ path: "grading/sources", code: "not_text_list" }]);
  });
});
