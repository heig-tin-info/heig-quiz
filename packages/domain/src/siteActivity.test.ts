import { describe, expect, it } from "vitest";

import { datesEndingOn, isClassHour, isWeekdayClassHour, offHoursStudentShare, offHoursWeekShare } from "./siteActivity.js";
import { localDate } from "./zone.js";

const day = (date: string, cells: Record<number, number>) => ({
  date,
  hours: Array.from({ length: 24 }, (_, h) => ({ students: cells[h] ?? 0 })),
});

describe("the class-hours window (ADR-107)", () => {
  it("is Monday to Friday, 08:00 included to 18:00 excluded", () => {
    // 2026-10-12 is a Monday, 2026-10-17 a Saturday.
    expect(isClassHour("2026-10-12", 8)).toBe(true);
    expect(isClassHour("2026-10-12", 17)).toBe(true);
    expect(isClassHour("2026-10-12", 7)).toBe(false);
    expect(isClassHour("2026-10-12", 18)).toBe(false);
    expect(isClassHour("2026-10-16", 10)).toBe(true);
    expect(isClassHour("2026-10-17", 10)).toBe(false);
    expect(isClassHour("2026-10-18", 10)).toBe(false);
  });
});

describe("the class-hours window of a week's grid (ADR-041 §8)", () => {
  it("is the rows Monday (0) to Friday (4), 08:00 included to 18:00 excluded", () => {
    expect(isWeekdayClassHour(0, 8)).toBe(true);
    expect(isWeekdayClassHour(4, 17)).toBe(true);
    expect(isWeekdayClassHour(0, 7)).toBe(false);
    expect(isWeekdayClassHour(2, 18)).toBe(false);
    expect(isWeekdayClassHour(5, 10)).toBe(false);
    expect(isWeekdayClassHour(6, 10)).toBe(false);
  });

  it("agrees with the dated window, day for day", () => {
    // 2026-10-12 is a Monday: the seven dates from it are the rows 0..6.
    for (let i = 0; i < 7; i++) {
      const date = `2026-10-${12 + i}`;
      for (let h = 0; h < 24; h++) expect(isWeekdayClassHour(i, h)).toBe(isClassHour(date, h));
    }
  });

  it("shares the grid's figures outside class hours, null for an empty grid", () => {
    const week = (cells: [number, number, number][]) => {
      const days = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      for (const [d, h, n] of cells) days[d]![h] = n;
      return days;
    };
    expect(offHoursWeekShare(week([]))).toBeNull();
    // Monday 10:00 (in), Monday 20:00 and Saturday 10:00 (out).
    expect(offHoursWeekShare(week([[0, 10, 2], [0, 20, 1], [5, 10, 1]]))).toBe(0.5);
    expect(offHoursWeekShare(week([[4, 17, 3]]))).toBe(0);
  });
});

describe("localDate", () => {
  it("is the school's calendar day, not UTC's", () => {
    // 23:30 UTC on Saturday the 24th is 01:30 on Sunday the 25th in Zurich (+02:00).
    expect(localDate(new Date("2026-10-24T23:30:00Z"), "Europe/Zurich")).toBe("2026-10-25");
    // 23:30 UTC on Sunday the 25th is 00:30 on Monday (+01:00 since 01:00 UTC).
    expect(localDate(new Date("2026-10-25T23:30:00Z"), "Europe/Zurich")).toBe("2026-10-26");
    expect(localDate(new Date("2026-10-25T22:30:00Z"), "Europe/Zurich")).toBe("2026-10-25");
  });
});

describe("datesEndingOn", () => {
  it("lists seven calendar dates, oldest first, across a DST change and a month", () => {
    expect(datesEndingOn("2026-10-27")).toEqual([
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
    expect(datesEndingOn("2026-11-02").slice(-3)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("offHoursStudentShare", () => {
  it("is null without a student person-hour", () => {
    expect(offHoursStudentShare([])).toBeNull();
    expect(offHoursStudentShare([day("2026-10-12", {})])).toBeNull();
  });

  it("counts the evenings, the early mornings and the weekend outside class hours", () => {
    const share = offHoursStudentShare([
      // Monday: 6 in class, 2 at 20:00, 1 at 07:00.
      day("2026-10-12", { 9: 6, 20: 2, 7: 1 }),
      // Saturday afternoon: outside, whatever the hour.
      day("2026-10-17", { 14: 1 }),
    ]);
    expect(share).toBeCloseTo(4 / 10);
  });
});
