import { describe, expect, it } from "vitest";

import { CRITERIA_PROTECTED } from "./protectedFiles.js";
import { previewPaths } from "./syncPreview.js";

describe("previewPaths (ADR-132 §10)", () => {
  const entries = [...CRITERIA_PROTECTED, "tests"];

  it("marks a listed file and a path under a listed directory protected, nothing else", () => {
    const { paths, more } = previewPaths(
      [
        { path: "src/main.c", change: "modified" },
        { path: "criteria.yml", change: "modified" },
        { path: ".github/workflows/grading.yml", change: "added" },
        { path: "tests/unit/test_a.c", change: "deleted" },
        { path: "testsuite.c", change: "added" },
      ],
      entries,
    );
    expect(more).toBe(0);
    expect(paths).toEqual([
      { path: ".github/workflows/grading.yml", change: "added", protected: true },
      { path: "criteria.yml", change: "modified", protected: true },
      { path: "tests/unit/test_a.c", change: "deleted", protected: true },
      { path: "src/main.c", change: "modified", protected: false },
      { path: "testsuite.c", change: "added", protected: false },
    ]);
  });

  it("caps the list, the protected paths kept first, and counts the rest", () => {
    const changes = [
      ...Array.from({ length: 5 }, (_, i) => ({ path: `a${i}.txt`, change: "added" as const })),
      { path: "criteria.yml", change: "modified" as const },
    ];
    const { paths, more } = previewPaths(changes, entries, 3);
    expect(paths.map((p) => p.path)).toEqual(["criteria.yml", "a0.txt", "a1.txt"]);
    expect(more).toBe(3);
  });

  it("marks nothing protected without a list", () => {
    expect(previewPaths([{ path: "criteria.yml", change: "added" }], []).paths[0]!.protected).toBe(false);
  });
});
