import { describe, expect, it } from "vitest";

import { ManualGradingBody, ValidateGradingBody } from "./grading.js";

/*
 * The bodies of a teacher's correction (F-GRADE-04/05, ADR-118 §6): the
 * total, or the points per criterion it is derived from, never both.
 */
describe("the correction bodies", () => {
  const criteria = [{ id: "c1", points: 1 }];

  it("never takes both the total and the criteria", () => {
    expect(ManualGradingBody.safeParse({ points: 2, criteria, comment: "ok" }).success).toBe(false);
    expect(ValidateGradingBody.safeParse({ points: 1, criteria }).success).toBe(false);
  });

  it("needs one of them in an override", () => {
    expect(ManualGradingBody.safeParse({ comment: "ok" }).success).toBe(false);
    expect(ManualGradingBody.safeParse({ criteria, comment: "ok" }).success).toBe(true);
  });
});
