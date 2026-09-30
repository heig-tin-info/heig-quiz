/**
 * The student branch of invariant 6, as a pure rule: every row of the table
 * in `classroomPayload`'s documentation, and the two properties it exists for
 * — `studentView` only narrows, and an impersonation session reads through
 * the student's seat alone.
 */
import { describe, expect, it } from "vitest";

import { classroomPayload, type ClassroomReadFacts } from "./guards.js";

const facts = (over: Partial<ClassroomReadFacts>): ClassroomReadFacts => ({
  seb: false,
  delegated: false,
  staff: false,
  seat: false,
  studentView: false,
  ...over,
});

const bools = [false, true];
/** Every combination of the five facts. */
const every: ClassroomReadFacts[] = bools.flatMap((seb) =>
  bools.flatMap((delegated) =>
    bools.flatMap((staff) =>
      bools.flatMap((seat) =>
        bools.map((studentView) => ({ seb, delegated, staff, seat, studentView })),
      ),
    ),
  ),
);

describe("classroomPayload", () => {
  it.each([
    ["staff", { staff: true }, "staff"],
    ["staff asking for the student view", { staff: true, studentView: true }, "student"],
    ["a claimed seat", { seat: true }, "student"],
    ["an impersonation session whose account also kept a staff seat", { delegated: true, staff: true }, null],
  ] as const)("%s", (_name, over, expected) => {
    expect(classroomPayload(facts(over))).toBe(expected);
  });

  it("never widens: asking for the student view never yields the staff payload", () => {
    for (const f of every.filter((f) => f.studentView)) {
      expect(classroomPayload(f), JSON.stringify(f)).not.toBe("staff");
    }
  });

  it("never lets anyone in who is neither staff nor seated", () => {
    for (const f of every.filter((f) => !f.staff && !f.seat)) {
      expect(classroomPayload(f), JSON.stringify(f)).toBeNull();
    }
  });

  it("serves an impersonation session the student payload or nothing, whatever it asks", () => {
    for (const f of every.filter((f) => f.delegated)) {
      expect([null, "student"], JSON.stringify(f)).toContain(classroomPayload(f));
      expect(classroomPayload(f)).toBe(classroomPayload({ ...f, staff: !f.staff, studentView: !f.studentView }));
    }
  });

  it("refuses every seb session", () => {
    for (const f of every.filter((f) => f.seb)) expect(classroomPayload(f)).toBeNull();
  });
});
