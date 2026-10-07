import { describe, expect, it } from "vitest";

import {
  ClassroomCreate,
  ClassroomPatch,
  CourseConditionCreate,
  CourseConditionOrder,
  CourseConditionPatch,
  CourseConditionsQuery,
} from "./org.js";

describe("ClassroomCreate — the dated period", () => {
  it("defaults to no dates", () => {
    expect(ClassroomCreate.parse({ name: "PRG1-2026" })).toEqual({
      name: "PRG1-2026",
      period: "",
      periodStart: null,
      periodEnd: null,
    });
  });

  it("accepts both months, end on or after start", () => {
    for (const [start, end] of [
      ["2026-09", "2027-01"],
      ["2026-05", "2026-05"],
    ]) {
      expect(
        ClassroomCreate.safeParse({ name: "x", periodStart: start, periodEnd: end }).success,
      ).toBe(true);
    }
  });

  it("refuses one month without the other", () => {
    expect(ClassroomCreate.safeParse({ name: "x", periodStart: "2026-09" }).success).toBe(false);
    expect(ClassroomCreate.safeParse({ name: "x", periodEnd: "2027-01" }).success).toBe(false);
  });

  it("refuses an end before the start", () => {
    const r = ClassroomCreate.safeParse({ name: "x", periodStart: "2027-01", periodEnd: "2026-09" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["periodEnd"]);
  });

  it("refuses anything that is not YYYY-MM", () => {
    for (const bad of ["2026-13", "2026-9", "2026-09-01", "Sept 2026"]) {
      expect(
        ClassroomCreate.safeParse({ name: "x", periodStart: bad, periodEnd: "2027-01" }).success,
      ).toBe(false);
    }
  });
});

describe("ClassroomPatch — the dated period", () => {
  it("sets both months, or clears both", () => {
    expect(ClassroomPatch.safeParse({ periodStart: "2026-09", periodEnd: "2027-01" }).success).toBe(
      true,
    );
    expect(ClassroomPatch.safeParse({ periodStart: null, periodEnd: null }).success).toBe(true);
  });

  it("refuses a patch that moves one month alone", () => {
    expect(ClassroomPatch.safeParse({ periodStart: "2026-09" }).success).toBe(false);
    expect(ClassroomPatch.safeParse({ periodStart: null, periodEnd: "2027-01" }).success).toBe(false);
  });

  it("refuses an end before the start", () => {
    expect(ClassroomPatch.safeParse({ periodStart: "2027-02", periodEnd: "2027-01" }).success).toBe(
      false,
    );
  });

  it("still takes a label alone", () => {
    expect(ClassroomPatch.safeParse({ period: "Automne 2026" }).success).toBe(true);
  });
});

describe("the course's catalog of conditions (F-ORG-16)", () => {
  it("takes a kind and a trimmed text of 1 to 200 characters, as an evaluation's condition", () => {
    expect(CourseConditionCreate.parse({ kind: "allowed", text: "  Notes  " })).toEqual({ kind: "allowed", text: "Notes" });
    expect(CourseConditionCreate.safeParse({ kind: "allowed", text: "   " }).success).toBe(false);
    expect(CourseConditionCreate.safeParse({ kind: "allowed", text: "x".repeat(201) }).success).toBe(false);
    expect(CourseConditionCreate.safeParse({ kind: "maybe", text: "Notes" }).success).toBe(false);
    // A catalog entry has no catalog reference of its own.
    expect(CourseConditionCreate.parse({ kind: "info", text: "a", catalogId: crypto.randomUUID() })).toEqual({
      kind: "info",
      text: "a",
    });
  });

  it("patches the kind, the text or both, never nothing", () => {
    expect(CourseConditionPatch.safeParse({ kind: "forbidden" }).success).toBe(true);
    expect(CourseConditionPatch.safeParse({}).success).toBe(false);
  });

  it("orders a non-empty list of ids, and lists the active entries unless asked", () => {
    expect(CourseConditionOrder.safeParse({ ids: [] }).success).toBe(false);
    expect(CourseConditionOrder.safeParse({ ids: ["nope"] }).success).toBe(false);
    expect(CourseConditionsQuery.parse({})).toEqual({ archived: "0" });
  });
});
