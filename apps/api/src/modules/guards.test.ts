/**
 * The student branch of invariant 6, as a pure rule: every row of the table
 * in `classroomPayload`'s documentation, and the two properties it exists for
 * — `studentView` only narrows, and an impersonation session reads through
 * the student's seat alone.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accessWhere,
  classroomPayload,
  mayHoldSuperPowers,
  reachOf,
  type ClassroomReadFacts,
} from "./guards.js";

const facts = (over: Partial<ClassroomReadFacts>): ClassroomReadFacts => ({
  confined: false,
  delegated: false,
  staff: false,
  seat: false,
  studentView: false,
  ...over,
});

const bools = [false, true];
/** Every combination of the five facts. */
const every: ClassroomReadFacts[] = bools.flatMap((confined) =>
  bools.flatMap((delegated) =>
    bools.flatMap((staff) =>
      bools.flatMap((seat) =>
        bools.map((studentView) => ({ confined, delegated, staff, seat, studentView })),
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

  it("refuses every confined session (seb, kiosk)", () => {
    for (const f of every.filter((f) => f.confined)) expect(classroomPayload(f)).toBeNull();
  });
});

/**
 * ADR-054: the admin role alone reaches nothing more than a teacher's seats;
 * the reach to everyone's content is an admin's own portal session with
 * Super Powers running by the server's clock, and nothing else.
 */
describe("reachOf", () => {
  const now = new Date("2026-09-30T10:00:00.000Z");
  const later = new Date(now.getTime() + 60_000);
  const portal = { kind: "portal" as const, actorUserId: null, superPowersUntil: later };

  it("reaches everyone's content for an admin's portal session with Super Powers on", () => {
    expect(reachOf({ role: "admin" }, portal, now)).toBe("all");
  });

  it("keeps an admin to their seats without them, or once their hour has passed", () => {
    expect(reachOf({ role: "admin" }, { ...portal, superPowersUntil: null }, now)).toBe("seats");
    expect(reachOf({ role: "admin" }, portal, later)).toBe("seats");
  });

  it("never reaches further for a token, a delegated or a seb session, or a non-admin", () => {
    expect(reachOf({ role: "admin" }, null, now)).toBe("seats");
    expect(reachOf({ role: "admin" }, { ...portal, actorUserId: "someone" }, now)).toBe("seats");
    expect(reachOf({ role: "admin" }, { ...portal, kind: "impersonation" }, now)).toBe("seats");
    expect(reachOf({ role: "admin" }, { ...portal, kind: "seb" }, now)).toBe("seats");
    expect(reachOf({ role: "teacher" }, portal, now)).toBe("seats");
  });

  it("is `mayHoldSuperPowers` plus a running hour: eligibility is written once", () => {
    expect(mayHoldSuperPowers({ role: "admin" }, portal)).toBe(true);
    expect(mayHoldSuperPowers({ role: "admin" }, null)).toBe(false);
    expect(mayHoldSuperPowers({ role: "admin" }, { ...portal, kind: "seb" })).toBe(false);
    expect(mayHoldSuperPowers({ role: "admin" }, { ...portal, actorUserId: "x" })).toBe(false);
    expect(mayHoldSuperPowers({ role: "teacher" }, portal)).toBe(false);
  });

  it("is what `accessWhere` reads: the predicate stays unless the reach is all", () => {
    const predicate = sql`true`;
    expect(accessWhere({ reach: "seats" }, predicate)).toBe(predicate);
    expect(accessWhere({ reach: "all" }, predicate)).toBeUndefined();
  });
});
