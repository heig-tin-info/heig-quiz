import { describe, expect, it } from "vitest";

import { joinReference, referenceEditorView, referenceRegions } from "./reference.js";
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

  it("reads a reference never written as the template's own text, as the editor shows it", () => {
    expect(referenceRegions(config("c", ONE_REGION, ""))).toEqual([ONE_REGION]);
  });

  it("cuts two regions on a C `@@next` line and drops the line itself", () => {
    const solution = "int sum(const int *t, int n)\n/* @@next */\n    return 1;";
    expect(referenceRegions(config("c", TWO_REGIONS_C, solution))).toEqual([
      "int sum(const int *t, int n)\n",
      "    return 1;\n",
    ]);
  });

  it("cuts two regions on a Python `@@next` line", () => {
    const solution = "def total(xs):\n    return sum(xs)\n# @@next\n    print(total([1]))\n";
    // The document's own last line break stays with the last piece.
    expect(referenceRegions(config("python", TWO_REGIONS_PY, solution))).toEqual([
      "def total(xs):\n    return sum(xs)\n",
      "    print(total([1]))\n\n",
    ]);
  });

  it("accepts the `// @@next` spelling too, like the lock markers", () => {
    const solution = "a\n  // @@next\nb\n";
    expect(referenceRegions(config("c", TWO_REGIONS_C, solution))).toEqual(["a\n", "b\n\n"]);
  });

  it("returns null when the template has two regions and the reference has one piece", () => {
    expect(referenceRegions(config("c", TWO_REGIONS_C, "int sum(void) { return 1; }"))).toBeNull();
  });

  it("returns null when the reference carries more pieces than the template has regions", () => {
    const solution = "return 0;\n// @@next\nextra";
    expect(referenceRegions(config("c", ONE_REGION, solution))).toBeNull();
  });

  it("leaves an empty piece empty rather than dropping it", () => {
    expect(referenceRegions(config("c", TWO_REGIONS_C, "// @@next\nb"))).toEqual(["\n", "b\n"]);
  });
});

describe("joinReference", () => {
  it("writes a one-region reference byte for byte", () => {
    const cfg = config("c", ONE_REGION, "");
    expect(joinReference(cfg, ["int main(void) {}\n"])).toBe("int main(void) {}\n");
  });

  it("joins several regions with the language's own @@next line", () => {
    expect(joinReference(config("c", TWO_REGIONS_C, ""), ["a\n", "b\n"])).toBe("a\n// @@next\nb");
    expect(joinReference(config("python", TWO_REGIONS_PY, ""), ["x\n", "y\n"])).toBe("x\n# @@next\ny");
  });

  it("is read back as the very regions it was given", () => {
    const cfg = config("c", TWO_REGIONS_C, "");
    for (const regions of [
      ["a\n", "b\n"],
      ["a\n\n", "\n"],
      ["\n", "  x;\n  y;\n"],
    ]) {
      const stored = joinReference(cfg, regions);
      expect(referenceRegions({ ...cfg, referenceSolution: stored })).toEqual(regions);
    }
  });
});

describe("referenceEditorView", () => {
  it("prefills a fresh reference with the template's editable text", () => {
    expect(referenceEditorView(config("c", TWO_REGIONS_C, ""), { prefillEmpty: true })).toEqual({
      regions: ["int sum(const int *t, int n)\n{\n", "    return 0;\n}\n"],
      extra: 0,
    });
  });

  it("prefills only the missing pieces once the teacher has typed", () => {
    expect(referenceEditorView(config("c", TWO_REGIONS_C, "// @@next\nb"), { prefillEmpty: false })).toEqual({
      regions: ["\n", "b\n"],
      extra: 0,
    });
    expect(referenceEditorView(config("c", TWO_REGIONS_C, "only one"), { prefillEmpty: false })).toEqual({
      regions: ["only one\n", "    return 0;\n}\n"],
      extra: 0,
    });
  });

  it("counts the pieces the template has no region for", () => {
    const view = referenceEditorView(config("c", ONE_REGION, "a\n// @@next\nb\n// @@next\nc"), {
      prefillEmpty: true,
    });
    expect(view).toEqual({ regions: ["a\n"], extra: 2 });
  });
});
