import { describe, expect, it } from "vitest";

import { referenceRegions } from "./reference.js";
import { CodeConfig, type CodeLanguage } from "./schema.js";

/** A config carrying `template` and `referenceSolution`, and nothing else of note. */
function config(language: CodeLanguage, template: string, referenceSolution: string): CodeConfig {
  return CodeConfig.parse({
    configVersion: 1,
    prompt: "p",
    language,
    template,
    referenceSolution,
    tests: { mode: "io", cases: [{ name: "one", stdin: "", expected: "", points: 1 }] },
  });
}

/** One editable region: a template with no marker at all. */
const ONE_REGION = "int main(void) {\n    return 0;\n}\n";

/** Two editable regions, split by one locked block. */
const TWO_REGIONS_C = `int sum(const int *t, int n)
{
// @@lock
    /* your code */
}

int main(void) {
// @@endlock
    return 0;
}
`;

const TWO_REGIONS_PY = `def total(xs):
# @@lock
    pass

def main():
# @@endlock
    print(total([]))
`;

describe("referenceRegions", () => {
  it("makes the whole reference the single region of a one-region template", () => {
    const solution = "int main(void) {\n    return 42;\n}\n";
    expect(referenceRegions(config("c", ONE_REGION, solution))).toEqual([solution]);
  });

  it("returns one empty region for an empty reference", () => {
    expect(referenceRegions(config("c", ONE_REGION, ""))).toEqual([""]);
  });

  it("cuts two regions on a C `@@next` line and drops the line itself", () => {
    const solution = "int sum(const int *t, int n)\n/* @@next */\n    return 1;";
    expect(referenceRegions(config("c", TWO_REGIONS_C, solution))).toEqual([
      "int sum(const int *t, int n)",
      "    return 1;",
    ]);
  });

  it("cuts two regions on a Python `@@next` line", () => {
    const solution = "def total(xs):\n    return sum(xs)\n# @@next\n    print(total([1]))\n";
    expect(referenceRegions(config("python", TWO_REGIONS_PY, solution))).toEqual([
      "def total(xs):\n    return sum(xs)",
      "    print(total([1]))",
    ]);
  });

  it("accepts the `// @@next` spelling too, like the lock markers", () => {
    const solution = "a\n  // @@next\nb\n";
    expect(referenceRegions(config("c", TWO_REGIONS_C, solution))).toEqual(["a", "b"]);
  });

  it("returns null when the template has two regions and the reference has one piece", () => {
    expect(referenceRegions(config("c", TWO_REGIONS_C, "int sum(void) { return 1; }"))).toBeNull();
  });

  it("returns null when the reference carries more pieces than the template has regions", () => {
    const solution = "return 0;\n// @@next\nextra";
    expect(referenceRegions(config("c", ONE_REGION, solution))).toBeNull();
  });

  it("leaves an empty piece empty rather than dropping it", () => {
    expect(referenceRegions(config("c", TWO_REGIONS_C, "// @@next\nb"))).toEqual(["", "b"]);
  });
});
