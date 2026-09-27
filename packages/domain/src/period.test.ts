import { describe, expect, it } from "vitest";

import {
  addMonths,
  currentOrNextSemester,
  isCurrent,
  nextSemester,
  PERIOD_MARGIN_MONTHS,
  semesterMonths,
  semesterOfRange,
  shiftSemester,
} from "./period.js";

describe("addMonths", () => {
  it("crosses year boundaries both ways", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-09", 6)).toBe("2027-03");
    expect(addMonths("2026-09", -21)).toBe("2024-12");
  });
});

describe("isCurrent", () => {
  // Autumn 2026: September 2026 … January 2027, margin one month each side.
  const start = "2026-09";
  const end = "2027-01";

  it("uses a one-month margin", () => {
    expect(PERIOD_MARGIN_MONTHS).toBe(1);
  });

  it("is current inside the period and within the margin, at both ends", () => {
    expect(isCurrent(start, end, "2026-07")).toBe(false);
    expect(isCurrent(start, end, "2026-08")).toBe(true);
    expect(isCurrent(start, end, "2026-09")).toBe(true);
    expect(isCurrent(start, end, "2026-11")).toBe(true);
    expect(isCurrent(start, end, "2027-01")).toBe(true);
    expect(isCurrent(start, end, "2027-02")).toBe(true);
    expect(isCurrent(start, end, "2027-03")).toBe(false);
  });

  it("takes a Date, read as its local month", () => {
    expect(isCurrent(start, end, new Date(2026, 7, 1))).toBe(true);
    expect(isCurrent(start, end, new Date(2026, 6, 31, 23, 59))).toBe(false);
    expect(isCurrent(start, end, new Date(2027, 1, 28))).toBe(true);
    expect(isCurrent(start, end, new Date(2027, 2, 1))).toBe(false);
  });

  it("treats a classroom without a period as always current", () => {
    expect(isCurrent(null, null, "1999-01")).toBe(true);
    expect(isCurrent(start, null, "1999-01")).toBe(true);
    expect(isCurrent(null, end, "1999-01")).toBe(true);
  });

  it("handles a one-month period", () => {
    expect(isCurrent("2026-05", "2026-05", "2026-04")).toBe(true);
    expect(isCurrent("2026-05", "2026-05", "2026-06")).toBe(true);
    expect(isCurrent("2026-05", "2026-05", "2026-07")).toBe(false);
  });
});

describe("semesters", () => {
  it("autumn N runs September N … January N+1, spring N February … July", () => {
    expect(semesterMonths({ season: "autumn", year: 2026 })).toEqual({
      start: "2026-09",
      end: "2027-01",
    });
    expect(semesterMonths({ season: "spring", year: 2027 })).toEqual({
      start: "2027-02",
      end: "2027-07",
    });
  });

  it("places every month in its semester, August in none", () => {
    // Read through currentOrNextSemester: August is the only month it moves.
    expect(currentOrNextSemester("2026-09")).toEqual({ season: "autumn", year: 2026 });
    expect(currentOrNextSemester("2026-12")).toEqual({ season: "autumn", year: 2026 });
    expect(currentOrNextSemester("2027-02")).toEqual({ season: "spring", year: 2027 });
    expect(semesterOfRange({ start: "2027-08", end: "2027-08" })).toBeNull();
  });

  it("reads a Date as its local month", () => {
    expect(currentOrNextSemester(new Date(2027, 0, 31, 23, 59))).toEqual({
      season: "autumn",
      year: 2026,
    });
    expect(currentOrNextSemester(new Date(2027, 1, 1, 0, 0, 1))).toEqual({
      season: "spring",
      year: 2027,
    });
  });

  it("nextSemester alternates and advances the year after autumn", () => {
    expect(nextSemester({ season: "autumn", year: 2026 })).toEqual({ season: "spring", year: 2027 });
    expect(nextSemester({ season: "spring", year: 2027 })).toEqual({ season: "autumn", year: 2027 });
  });

  it("currentOrNextSemester is the running one, or the coming autumn in August", () => {
    expect(currentOrNextSemester("2026-09")).toEqual({ season: "autumn", year: 2026 });
    expect(currentOrNextSemester("2027-01")).toEqual({ season: "autumn", year: 2026 });
    expect(currentOrNextSemester("2027-07")).toEqual({ season: "spring", year: 2027 });
    expect(currentOrNextSemester("2027-08")).toEqual({ season: "autumn", year: 2027 });
  });

  it("semesterOfRange recognises exactly a semester, nothing else", () => {
    expect(semesterOfRange({ start: "2026-09", end: "2027-01" })).toEqual({
      season: "autumn",
      year: 2026,
    });
    expect(semesterOfRange({ start: "2026-09", end: "2027-02" })).toBeNull();
    expect(semesterOfRange({ start: "2026-08", end: "2027-01" })).toBeNull();
  });
});

describe("shiftSemester (F-ORG-10)", () => {
  it("moves a semester to the next one", () => {
    expect(shiftSemester({ start: "2026-09", end: "2027-01" })).toEqual({
      start: "2027-02",
      end: "2027-07",
    });
    expect(shiftSemester({ start: "2027-02", end: "2027-07" })).toEqual({
      start: "2027-09",
      end: "2028-01",
    });
  });

  it("moves any other period six months, keeping its length", () => {
    expect(shiftSemester({ start: "2026-09", end: "2027-07" })).toEqual({
      start: "2027-03",
      end: "2028-01",
    });
  });
});
