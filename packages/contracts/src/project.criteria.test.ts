import { describe, expect, it } from "vitest";

import { CriterionId, EvidencePath, ProjectArgv, ProjectPatch, effectiveTestsCriterion } from "./project.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("the criteria settings (ADR-106 §2, §3)", () => {
  it("takes a dotted criterion id, never a dot at an end, a double dot or a space", () => {
    expect(ok(CriterionId, "rendu.all-tests-passed")).toBe(true);
    for (const bad of ["", ".rendu", "rendu.", "a..b", "a b", "x".repeat(301)]) expect(ok(CriterionId, bad)).toBe(false);
  });

  it("takes a command as its argv, without a shell", () => {
    expect(ok(ProjectArgv, ["make", "prepare"])).toBe(true);
    for (const bad of [[], ["make prepare"], ["make", ""], ["a;b"], ["$(x)"], Array.from({ length: 21 }, () => "a")]) {
      expect(ok(ProjectArgv, bad)).toBe(false);
    }
  });

  it("takes a relative output path, a directory with its slash", () => {
    for (const good of ["report.xml", "build/", "out/a.txt"]) expect(ok(EvidencePath, good)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/./b", "a\\b", "a\0b", "a//b"]) expect(ok(EvidencePath, bad)).toBe(false);
  });

  it("patches the settings, each null for its default, and refuses an empty patch", () => {
    expect(ok(ProjectPatch, { testsCriterion: null, buildCommand: ["make"], testCommand: null, evidenceOutputs: ["build/"] })).toBe(true);
    expect(ok(ProjectPatch, { evidenceOutputs: [] })).toBe(false);
    expect(ok(ProjectPatch, {})).toBe(false);
  });

  it("applies the default tests criterion only when the project has none", () => {
    expect(effectiveTestsCriterion({ testsCriterion: null })).toBe("rendu.all-tests-passed");
    expect(effectiveTestsCriterion({ testsCriterion: "t.all" })).toBe("t.all");
  });
});
