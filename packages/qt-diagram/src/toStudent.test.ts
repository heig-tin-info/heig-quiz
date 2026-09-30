/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04). The generic half — the full fixture of `./testing.ts` searched
 * for every forbidden key and secret value — is the registry's contract test.
 */
import { describe, expect, it } from "vitest";

import { SECRET_CONFIG as full, STARTER } from "./test/fixtures.js";
import { diagramServer } from "./server.js";

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };

  it("keeps exactly the prompt, the kind and the starter", () => {
    const student = diagramServer.toStudent(full, view);
    expect(student).toEqual({ prompt: full.prompt, kind: "class", starter: STARTER });
  });

  it("omits the starter when the teacher gave none", () => {
    const { starter: _drop, ...bare } = full;
    expect("starter" in diagramServer.toStudent(bare, view)).toBe(false);
  });

  it("refuses a student payload carrying anything more (strict schema)", () => {
    const student = diagramServer.toStudent(full, view);
    expect(diagramServer.studentSchema.safeParse({ ...student, reference: full.reference }).success).toBe(false);
  });

  it("gives a student the reference but never the rubric (ADR-037)", () => {
    const solution = diagramServer.toSolution(full, view);
    expect(solution).toEqual({ reference: full.reference, rubric: full.rubric });
    expect(diagramServer.studentSolution?.(solution, full)).toEqual({ reference: full.reference });
  });
});
