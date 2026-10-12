import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  clampAwarded,
  classifyCriterion,
  commandNeedsNetwork,
  criteriaTotals,
  passLeaves,
  untaggedCheckpoints,
  workflowTestsCriterion,
  type ParsedCriteria,
} from "./criteria.js";
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

const LABO_00_IDS = [
  "rendu.all-tests-passed",
  "rapport.reponses",
  "rapport.presentation",
  "rapport.redaction",
  "rapport.cle-privee",
  "git.commits",
  "bonus.proactivite",
];

const item = (extra: string) => `schema_version: 2\ncriteria:\n  s:\n    c:\n      description: d\n      awarded_points: 0\n${extra}`;

describe("parseCriteria on labo 00", () => {
  for (const name of ["labo-00-revised.yml"]) {
    it(`reads ${name}: seven criteria, 20 points, a penalty and a bonus`, () => {
      const criteria = parsed(fixture(name));
      expect(criteria.schemaVersion).toBe(2);
      expect(criteria.leaves.map((l) => l.id)).toEqual(LABO_00_IDS);
      expect(criteria.leaves.map((l) => l.maxPoints)).toEqual([12, 4, 2, 1, -3, 1, 0]);
      expect(criteria.leaves[6]).toMatchObject({ sectionPath: ["bonus"], bonusPoints: 1 });
      expect(criteria.leaves.every((l) => l.prompt !== undefined)).toBe(true);
      expect(criteria.sections.map((s) => [s.id, s.description])).toEqual([
        ["rendu", "Conformité du rendu (vérifications automatiques)"],
        ["rapport", "Rapport Word (rendu/rapport.docx, lu dans build/rapport.md)"],
        ["git", "Utilisation de Git"],
        ["bonus", "Bonus"],
      ]);
      expect(criteria.grading.sources).toContain("build/rapport.md");
      expect(criteria.grading.context).toMatch(/^Tu es un correcteur impartial/);
      expect(criteria.grading.student?.knows).toEqual(["utilisation courante de Windows et de Microsoft Word"]);
      expect(criteriaTotals(criteria.leaves, {})).toEqual({ points: 0, max: 20, bonusMax: 1, missing: LABO_00_IDS });
    });
  }

  it("classifies with the tests criterion: automatic first, the rest by its prompt", () => {
    const { leaves } = parsed(fixture("labo-00-revised.yml"));
    const kinds = leaves.map((l) => classifyCriterion(l, { testsCriterion: "rendu.all-tests-passed", identityCriterion: null }));
    expect(kinds).toEqual(["automatic", "llm", "llm", "llm", "llm", "llm", "llm"]);
    expect(classifyCriterion(leaves[0]!, { testsCriterion: "git.commits", identityCriterion: null })).toBe("llm");
  });

  it("totals a sample at 10.5 out of 20, with the penalty and the bonus", () => {
    const { leaves } = parsed(fixture("labo-00-revised.yml"));
    const awarded = {
      "rendu.all-tests-passed": 8,
      "rapport.reponses": 2,
      "rapport.presentation": 1,
      "rapport.redaction": 0.5,
      "rapport.cle-privee": -3,
      "git.commits": 1,
      "bonus.proactivite": 1,
    };
    expect(criteriaTotals(leaves, awarded)).toEqual({ points: 10.5, max: 20, bonusMax: 1, missing: [] });
    expect(criteriaTotals(leaves, { ...awarded, "git.commits": null })).toMatchObject({ points: 9.5, missing: ["git.commits"] });
  });
});

describe("classifyCriterion", () => {
  it("makes a criterion with `test` automatic, even with a prompt; one with neither the teacher's", () => {
    expect(classifyCriterion({ id: "a.b", test: "test_x", prompt: "p" }, { testsCriterion: "a.c", identityCriterion: null })).toBe("automatic");
    expect(classifyCriterion({ id: "a.b" }, { testsCriterion: "a.c", identityCriterion: null })).toBe("teacher");
  });

  it("makes the identity criterion automatic, even with a prompt", () => {
    expect(classifyCriterion({ id: "git.commits", prompt: "p" }, { testsCriterion: "a.c", identityCriterion: "git.commits" })).toBe("automatic");
    expect(classifyCriterion({ id: "git.commits" }, { testsCriterion: "a.c", identityCriterion: "git.commits" })).toBe("automatic");
    expect(classifyCriterion({ id: "git.commits", prompt: "p" }, { testsCriterion: "a.c", identityCriterion: null })).toBe("llm");
  });

  it("reads `test` from the file", () => {
    expect(parsed(item("      max_points: 2\n      test: tests/test_x.py\n")).leaves[0]).toMatchObject({ test: "tests/test_x.py", maxPoints: 2 });
  });
});

describe("workflowTestsCriterion", () => {
  it("reads the workflow's tests-criterion input, quoted or not", () => {
    const workflow = (line: string) => `jobs:\n  grade:\n    uses: heig-tin-info/score/.github/workflows/grading.yml@0.7.5\n    with:\n${line}\n`;
    expect(workflowTestsCriterion(workflow("      tests-criterion: rendu.all-tests-passed"))).toBe("rendu.all-tests-passed");
    expect(workflowTestsCriterion(workflow(`      tests-criterion: "tests.pass" # the automatic one`))).toBe("tests.pass");
    expect(workflowTestsCriterion(workflow("      build-command: make prepare"))).toBeNull();
  });
});

describe("untaggedCheckpoints (ADR-106 §5)", () => {
  it("names the checkpoints no criterion is tagged with", () => {
    expect(untaggedCheckpoints(["mid", "early"], [{ milestone: "mid" }, {}])).toEqual(["early"]);
    expect(untaggedCheckpoints([], [])).toEqual([]);
  });
});

describe("passLeaves (ADR-106 §5)", () => {
  const leaves = [{ id: "a", milestone: "mid" }, { id: "b" }, { id: "c", milestone: "late" }];
  it("keeps a milestone's tagged criteria only, and every criterion for the final pass", () => {
    expect(passLeaves(leaves, "mid").map((l) => l.id)).toEqual(["a"]);
    expect(passLeaves(leaves, "none")).toEqual([]);
    expect(passLeaves(leaves, null).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });
});

describe("commandNeedsNetwork (ADR-106 §1)", () => {
  it("finds a package manager, a downloader or git as the program", () => {
    for (const argv of [
      ["pip", "install", "pytest"],
      ["pip3", "install", "x"],
      ["/usr/bin/apt-get", "install", "pandoc"],
      ["apt", "install", "x"],
      ["apk", "add", "x"],
      ["npm", "ci"],
      ["pnpm", "install"],
      ["yarn"],
      ["curl", "-O", "https://example.org/x"],
      ["wget", "x"],
      ["git", "clone", "x"],
      ["python", "-m", "pip", "install", "x"],
      ["python3.12", "-m", "pip3", "install", "x"],
    ]) {
      expect(commandNeedsNetwork(argv), argv.join(" ")).toBe(true);
    }
  });

  it("lets the defaults and an ordinary command through", () => {
    for (const argv of [["make", "prepare"], ["pytest", "--junitxml=report.xml", "-q"], ["python3", "-m", "pytest"], ["make", "pip"], ["python", "pip"]]) {
      expect(commandNeedsNetwork(argv), argv.join(" ")).toBe(false);
    }
  });
});

describe("criteriaTotals and clampAwarded", () => {
  const leaves = [
    { id: "a", maxPoints: 4 },
    { id: "p", maxPoints: -3 },
    { id: "b", maxPoints: 0, bonusPoints: 2 },
  ];

  it("clamps each criterion into its range", () => {
    expect(clampAwarded(leaves[0]!, 9)).toBe(4);
    expect(clampAwarded(leaves[0]!, -1)).toBe(0);
    expect(clampAwarded(leaves[1]!, -5)).toBe(-3);
    expect(clampAwarded(leaves[1]!, 2)).toBe(0);
    expect(clampAwarded(leaves[2]!, 3)).toBe(2);
  });

  it("clamps the total to [0, max + bonus]", () => {
    expect(criteriaTotals(leaves, { a: 0, p: -3, b: 0 }).points).toBe(0);
    expect(criteriaTotals(leaves, { a: 4, p: 0, b: 2 })).toEqual({ points: 6, max: 4, bonusMax: 2, missing: [] });
  });
});

describe("parseCriteria refusals", () => {
  it("refuses a YAML syntax error and a document that is not a mapping", () => {
    expect(errors("a: [b").errors[0]).toMatchObject({ path: "<root>", code: "yaml_syntax", params: { line: 1 } });
    expect(errors("- a").errors).toEqual([{ path: "<root>", code: "not_mapping" }]);
  });

  it("refuses schema version 1, an unknown version, and a file without criteria", () => {
    expect(errors("criteria:\n  a:\n    $desc: x\n").errors).toEqual([{ path: "schema_version", code: "schema_v1" }]);
    expect(errors("schema_version: 3\n").errors[0]!.code).toBe("schema_version");
    expect(errors("schema_version: 2\n").errors).toEqual([{ path: "criteria", code: "missing_criteria" }]);
    expect(errors("schema_version: 2\ncriteria: [a]\n").errors[0]!.code).toBe("not_mapping");
    expect(errors("schema_version: 2\ncriteria:\n  s:\n    description: only\n").errors[0]!.code).toBe("no_criteria");
  });

  it("names the path of each wrong criterion", () => {
    const text = [
      "schema_version: 2",
      "criteria:",
      "  s:",
      "    description: 3",
      "    a.b: {max_points: 1, awarded_points: 0, description: x}",
      "    flat: 4",
      "    c:",
      "      awarded_points: 0",
      "      max_points: '50%'",
      "      unknown: 1",
      "      milestone: Not-OK",
      "      prompt: [1]",
      "    d:",
      "      description: d",
      "      max_points: 2",
      "      bonus_points: 1",
      "    e:",
      "      description: [1]",
      "      rationale: 3",
      "      awarded_points: 0",
      "    f: {description: f, awarded_points: 0, max_points: 0}",
      "    g: {description: g, awarded_points: 0, bonus_points: -1}",
      "    h: {description: h, awarded_points: 0, max_points: 2.5}",
    ].join("\n");
    expect(errors(text).errors).toEqual([
      { path: "criteria/s/description", code: "not_string" },
      { path: "criteria/s/a.b", code: "dotted_key" },
      { path: "criteria/s/flat", code: "not_mapping" },
      { path: "criteria/s/c/unknown", code: "unknown_key" },
      { path: "criteria/s/c", code: "missing_description" },
      { path: "criteria/s/c/prompt", code: "not_string" },
      { path: "criteria/s/c/milestone", code: "bad_milestone" },
      { path: "criteria/s/c/max_points", code: "percent_max" },
      { path: "criteria/s/d/awarded_points", code: "missing_awarded" },
      { path: "criteria/s/d", code: "both_points" },
      { path: "criteria/s/e/description", code: "not_text" },
      { path: "criteria/s/e/rationale", code: "not_text" },
      { path: "criteria/s/e", code: "missing_points" },
      { path: "criteria/s/f/max_points", code: "zero_points" },
      { path: "criteria/s/g/bonus_points", code: "negative_bonus" },
      { path: "criteria/s/h/max_points", code: "not_integer" },
    ]);
  });

  it("checks awarded_points against the criterion's range, a percentage of its own maximum", () => {
    const awarded = (value: string, max = 4) => parseCriteria(item(`      max_points: ${max}\n`).replace("awarded_points: 0", `awarded_points: ${value}`));
    expect(awarded("'50%'").ok).toBe(true);
    expect(awarded("'-50%'", -2).ok).toBe(true);
    const refusal = (value: string, max?: number) => {
      const result = awarded(value, max);
      return result.ok ? null : result.errors[0];
    };
    expect(refusal("'half'")?.code).toBe("bad_percent");
    expect(refusal("'150%'")?.code).toBe("percent_range");
    expect(refusal("[1]")?.code).toBe("not_numeric");
    const outOfRange = (awarded: number, max: number) => ({ path: "criteria/s/c/max_points", code: "awarded_out_of_range", params: { awarded, max } });
    expect(refusal("-5", -3)).toEqual(outOfRange(-5, -3));
    expect(refusal("1", -3)).toEqual(outOfRange(1, -3));
    expect(refusal("-1")).toEqual(outOfRange(-1, 4));
    expect(refusal("5")).toEqual(outOfRange(5, 4));
  });

  it("validates the grading block", () => {
    const grading = (block: string) => `schema_version: 2\ngrading:\n${block}\ncriteria:\n  c: {description: c, awarded_points: 0, max_points: 1}\n`;
    expect(parsed(grading("  context: [a, b]\n  student: {level: L, learning: [x]}")).grading).toEqual({
      context: "a\nb",
      sources: [],
      student: { level: "L", learning: ["x"] },
    });
    expect(parsed("schema_version: 2\ncriteria:\n  c: {description: c, awarded_points: 0, max_points: 1, rationale: ~}\n")).toMatchObject({
      grading: { context: null, sources: [] },
      leaves: [{ id: "c", sectionPath: [] }],
    });
    expect(errors(grading("  sources: a\n  other: 1\n  student: {level: 1, knows: a, age: 3}")).errors).toEqual([
      { path: "grading/sources", code: "not_text_list" },
      { path: "grading/other", code: "unknown_key" },
      { path: "grading/student/level", code: "not_string" },
      { path: "grading/student/knows", code: "not_text_list" },
      { path: "grading/student/age", code: "unknown_key" },
    ]);
    expect(errors(grading("  student: x")).errors[0]!.code).toBe("not_mapping");
    expect(errors("schema_version: 2\ngrading: x\ncriteria:\n  c: {description: c, awarded_points: 0, max_points: 1}\n").errors[0]).toEqual({
      path: "grading",
      code: "not_mapping",
    });
  });

  it("reads desc as description's short form, never both", () => {
    expect(parsed("schema_version: 2\ncriteria:\n  c: {desc: Short, awarded_points: 0, max_points: 1}\n").leaves[0]!.description).toBe("Short");
    expect(errors("schema_version: 2\ncriteria:\n  c: {desc: a, description: b, awarded_points: 0, max_points: 1}\n").errors).toEqual([
      { path: "criteria/c", code: "both_descriptions" },
    ]);
  });

  it("keeps a milestone tag", () => {
    expect(parsed(item("      max_points: 1\n      milestone: mid-review\n")).leaves[0]!.milestone).toBe("mid-review");
  });
});
