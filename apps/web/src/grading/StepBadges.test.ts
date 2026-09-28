import { describe, expect, it } from "vitest";

import type { GradingQueueItem } from "@quiz/contracts";

import { makeEntry, makeGrading } from "../test/grading-fixtures";
import { studentTotal } from "./StepBadges";

/*
 * The running total of one student's copy (#108), as the step header shows
 * it: the server's rule (`attemptTotal`), the maximum of every question, and
 * "provisional" while anything is not validated yet.
 */

const item = (id: string, points: number): GradingQueueItem => ({
  id,
  position: 0,
  internalName: id,
  type: "mcq",
  points,
  minPoints: 0,
});
const ITEMS = new Map([
  ["i1", item("i1", 2)],
  ["i2", item("i2", 3)],
]);

describe("studentTotal", () => {
  it("is null for an empty copy", () => {
    expect(studentTotal([], ITEMS)).toBeNull();
  });

  it("sums the points and the maxima, provisional while a proposal is left", () => {
    const entries = [
      makeEntry({ itemId: "i1", grading: makeGrading({ points: 2, maxPoints: 2, state: "validated" }) }),
      makeEntry({ itemId: "i2", grading: makeGrading({ itemId: "i2", points: 1, maxPoints: 3 }) }),
    ];
    expect(studentTotal(entries, ITEMS)).toEqual({ points: 3, max: 5, provisional: true });
  });

  it("counts an ungraded answer as 0 out of its item's points, and provisional", () => {
    const entries = [
      makeEntry({ itemId: "i1", grading: makeGrading({ points: 2, maxPoints: 2, state: "validated" }) }),
      makeEntry({ itemId: "i2", grading: null }),
    ];
    expect(studentTotal(entries, ITEMS)).toEqual({ points: 2, max: 5, provisional: true });
  });

  it("is settled once every answer is validated, and floored at 0", () => {
    const entries = [
      makeEntry({ itemId: "i1", grading: makeGrading({ points: -1, maxPoints: 2, state: "validated" }) }),
      makeEntry({ itemId: "i2", grading: makeGrading({ itemId: "i2", points: 0, maxPoints: 3, state: "validated" }) }),
    ];
    expect(studentTotal(entries, ITEMS)).toEqual({ points: 0, max: 5, provisional: false });
  });
});
