import { describe, expect, it } from "vitest";

import { MASK, maskNames } from "./maskNames.js";
import { llmLeaves, MATERIAL_LIMITS, renderMaterial, type MaterialEvidence } from "./projectReview.js";

const step = (stdout: string) => ({ exitCode: 1, stdout, stderr: "", timedOut: false });
const evidence = (over: Partial<MaterialEvidence> = {}): MaterialEvidence => ({
  cases: [
    { name: "a", classname: "t", passed: true },
    { name: "b", classname: "t", passed: false, message: "expected 1" },
  ],
  build: step("built"),
  test: null,
  files: {
    "report.xml": { content: "<testsuites/>", truncated: false },
    "build/rapport.md": { content: "# Rapport", truncated: false },
    "src/x.c": { content: "int x;", truncated: true },
  },
  ...over,
});
const mask = (text: string) => maskNames(text, [], ["jdoe42"]);

describe("llmLeaves", () => {
  it("keeps the criteria the model proposes: a prompt, neither the tests criterion nor a test", () => {
    const leaves = [
      { id: "r.tests", sectionPath: ["r"], description: "T", maxPoints: 4, prompt: "?" },
      { id: "r.style", sectionPath: ["r"], description: "S", maxPoints: 2, prompt: "?" },
      { id: "r.unit", sectionPath: ["r"], description: "U", maxPoints: 2, prompt: "?", test: "t" },
      { id: "r.who", sectionPath: ["r"], description: "W", maxPoints: 2 },
    ];
    expect(llmLeaves(leaves, "r.tests").map((l) => l.id)).toEqual(["r.style"]);
  });
});

describe("renderMaterial", () => {
  it("renders the summary, the failures, the steps and the source files, never the report", () => {
    const text = renderMaterial(evidence(), ["build/"], mask);
    expect(text).toContain("Tests: 1 of 2 passed.");
    expect(text).toContain("- t.b: expected 1");
    expect(text).toContain("Build step: exit code 1\nstdout:\nbuilt");
    expect(text).toContain("File build/rapport.md:\n```\n# Rapport\n```");
    expect(text).not.toContain("src/x.c");
    expect(text).not.toContain("<testsuites/>");
    expect(renderMaterial(evidence(), [], mask)).toContain("File src/x.c (truncated):");
  });

  it("masks before it cuts: a login across a limit never leaves a fragment", () => {
    // Cut first, the output would keep `oe42`, the file `jdo`.
    const out = `jdoe42 ${"x".repeat(MATERIAL_LIMITS.output - 5)}`;
    const file = `${"y".repeat(MATERIAL_LIMITS.file - 3)} jdoe42`;
    const text = renderMaterial(
      evidence({ build: step(out), files: { "build/a.txt": { content: file, truncated: false }, "build/jdoe42.md": { content: "", truncated: false } } }),
      ["build/"],
      mask,
    );
    for (const fragment of ["jdo", "oe42"]) expect(text).not.toContain(fragment);
    expect(text).toContain(MASK);
  });

  it("caps the whole material", () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, { content: "z".repeat(MATERIAL_LIMITS.file), truncated: false }]));
    expect(renderMaterial(evidence({ files }), [], mask).length).toBeLessThanOrEqual(MATERIAL_LIMITS.material + 2);
  });
});
