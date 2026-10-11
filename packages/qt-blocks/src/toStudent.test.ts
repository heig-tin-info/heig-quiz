/**
 * The type-specific half of the leak test (docs/05 §5.7, N-SEC-04, spec
 * 4.17, amendment D7').
 *
 * The registry's contract test runs the fixture of `./testing.ts` through
 * `toStudent` and searches it by forbidden key and by value. This file adds
 * what is particular to `blocks`: the exact keys a student receives, the
 * hidden warehouses reduced to a count and their points, and the redaction
 * of `studentDetails` — searched for the hidden trails' cells and move
 * counts.
 */
import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";

import type { GradedResult } from "@quiz/core/server";
import { testGradeContext } from "@quiz/core/testing";

import type { BlocksDetails } from "./schema.js";
import { blocksServer } from "./server.js";
import { blocksLeakFixture, SECRET_CONFIG } from "./testing.js";

const view = { seed: 0, itemId: "i", shuffle: false };

/** The reference itself as the answer: every warehouse reached, each trail recorded. */
function graded(): BlocksDetails {
  const result = blocksServer.grade(SECRET_CONFIG, { program: SECRET_CONFIG.referenceSolution! }, testGradeContext(5));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a synchronous grade");
  return (result as GradedResult<BlocksDetails>).details;
}

describe("toStudent", () => {
  const student = blocksServer.toStudent(SECRET_CONFIG, view);

  it("leaks neither a forbidden key nor a value of the key", () => {
    expect(findStudentLeaks(student, blocksLeakFixture)).toEqual([]);
    expect(blocksServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("keeps exactly what the player needs", () => {
    expect(Object.keys(student).sort()).toEqual([
      "allOrNothing",
      "hiddenCount",
      "hiddenPoints",
      "prompt",
      "starter",
      "toolbox",
      "visibleCases",
      "world",
    ]);
    for (const kase of student.visibleCases) expect(Object.keys(kase).sort()).toEqual(["battery", "map", "name", "points"]);
  });

  it("publishes the visible warehouses whole and the hidden ones as a count and their points", () => {
    expect(student.visibleCases.map((k) => k.name)).toEqual(["Clear aisle", "Rack on the aisle"]);
    expect(student.visibleCases[0]!.map).toEqual(SECRET_CONFIG.cases[0]!.map);
    expect(student.hiddenCount).toBe(2);
    expect(student.hiddenPoints).toBe(5);
  });

  it("would be caught serving the config whole: the fixture's secrets are in it", () => {
    expect(findStudentLeaks(SECRET_CONFIG, blocksLeakFixture).some((leak) => leak.startsWith("secret value"))).toBe(true);
  });
});

describe("studentDetails", () => {
  const details = graded();
  const hidden = details.cases.filter((c) => !c.visible);

  it("hands the details over whole under a shown key", () => {
    expect(blocksServer.studentDetails!(details, { showKey: true, showHiddenCaseNames: false })).toBe(details);
  });

  it("keeps a visible warehouse whole", () => {
    const out = blocksServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: false }) as BlocksDetails;
    expect(out.cases[0]).toEqual(details.cases[0]);
    expect(out.cases[1]).toEqual(details.cases[1]);
  });

  it("reduces a hidden warehouse to its verdict, its points and the coarse reason", () => {
    const out = blocksServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: false }) as BlocksDetails;
    expect(out.cases[2]).toEqual({ name: "#3", visible: false, points: 2, ok: true, reason: "dock" });
    expect(out.cases[3]).toEqual({ name: "#4", visible: false, points: 3, ok: true, reason: "dock" });
    const serialized = JSON.stringify(out.cases.slice(2));
    expect(serialized).not.toContain("trail");
    expect(serialized).not.toContain("moves");
    expect(serialized).not.toContain("Hidden north-east");
  });

  it("never carries a hidden trail's cells nor its move count", () => {
    const out = JSON.stringify(blocksServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: false }));
    for (const c of hidden) {
      // Each hidden trail serialized as it would be stored, and its count with its key.
      expect(out).not.toContain(JSON.stringify(c.trail));
      expect(out).not.toContain(`"moves":${c.moves}`);
    }
  });

  it("opens the hidden names when the policy does, and nothing more", () => {
    const out = blocksServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: true }) as BlocksDetails;
    expect(out.cases[2]).toEqual({ name: "Hidden north-east", visible: false, points: 2, ok: true, reason: "dock" });
  });

  it("stores no map in the details (spec 4.17)", () => {
    const stored = JSON.stringify(details);
    for (const kase of SECRET_CONFIG.cases) expect(stored).not.toContain(JSON.stringify(kase.map));
    expect(stored).not.toContain('"map"');
  });
});
