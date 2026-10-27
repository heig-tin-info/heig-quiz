import { describe, expect, it } from "vitest";

import { ManualGradingBody, ValidateGradingBody } from "./grading.js";

/*
 * The bodies of a teacher's correction (F-GRADE-04/05, ADR-118 §6): the
 * total, or the points per criterion it is derived from, never both.
 */
describe("the correction bodies", () => {
  const criteria = [
    { id: "c1", points: 1 },
    { id: "c-2", points: 0.5 },
  ];

  it("takes either the total or the criteria in an override, with its comment", () => {
    expect(ManualGradingBody.safeParse({ points: 2, comment: "ok" }).success).toBe(true);
    expect(ManualGradingBody.safeParse({ criteria, comment: "ok" }).success).toBe(true);
    expect(ManualGradingBody.safeParse({ points: 2, criteria, comment: "ok" }).success).toBe(false);
    expect(ManualGradingBody.safeParse({ comment: "ok" }).success).toBe(false);
  });

  it("takes neither, one or the other in a validation, never both", () => {
    expect(ValidateGradingBody.safeParse({}).success).toBe(true);
    expect(ValidateGradingBody.safeParse({ criteria }).success).toBe(true);
    expect(ValidateGradingBody.safeParse({ points: 1 }).success).toBe(true);
    expect(ValidateGradingBody.safeParse({ points: 1, criteria }).success).toBe(false);
  });

  it("refuses an id that is no criterion id, a negative point, more than twelve", () => {
    expect(ValidateGradingBody.safeParse({ criteria: [{ id: "a b", points: 1 }] }).success).toBe(false);
    expect(ValidateGradingBody.safeParse({ criteria: [{ id: "a", points: -1 }] }).success).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, points: 0 }));
    expect(ValidateGradingBody.safeParse({ criteria: many }).success).toBe(false);
  });
});
