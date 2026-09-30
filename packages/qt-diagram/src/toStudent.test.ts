/** The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04). */
import { describe, expect, it } from "vitest";
import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";

import { config, SECRET_VALUES, STARTER } from "./test/fixtures.js";
import { diagramServer } from "./server.js";

/** The shared floor plus what only `diagram` holds: the reference diagram. */
const FORBIDDEN_KEYS = [...COMMON_FORBIDDEN_STUDENT_KEYS, "reference", "rubric"];

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };
  const full = config();

  it("leaks no key", () => {
    const out = JSON.stringify(diagramServer.toStudent(full, view));
    for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
  });

  it("leaks no value of the reference nor the rubric", () => {
    const out = JSON.stringify(diagramServer.toStudent(full, view));
    for (const secret of SECRET_VALUES) expect(out).not.toContain(secret);
  });

  it("keeps exactly the prompt, the kind and the starter", () => {
    const student = diagramServer.toStudent(full, view);
    expect(student).toEqual({ prompt: full.prompt, kind: "class", starter: STARTER });
    expect(diagramServer.studentSchema.safeParse(student).success).toBe(true);
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
