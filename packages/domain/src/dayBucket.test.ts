import { describe, expect, it } from "vitest";

import { dayBucket, groupByDay, type DayBucket } from "./dayBucket.js";

const ZH = "Europe/Zurich";
const ms = (iso: string) => Date.parse(iso);

describe("dayBucket", () => {
  // 2026-10-01 is a Thursday; Zurich is at +02:00 until 25 October.
  const thursday = ms("2026-10-01T10:00:00+02:00");
  const saturday = ms("2026-10-03T12:00:00+02:00");
  const sunday = ms("2026-10-04T20:00:00+02:00");
  const monday = ms("2026-10-05T08:00:00+02:00");

  const table: [string, number, string, DayBucket][] = [
    ["later the same day", thursday, "2026-10-01T23:59:59+02:00", "today"],
    ["already passed today", thursday, "2026-10-01T07:00:00+02:00", "today"],
    ["yesterday (the ticker has not opened it yet)", thursday, "2026-09-30T09:00:00+02:00", "today"],
    ["the first second of tomorrow", thursday, "2026-10-02T00:00:00+02:00", "tomorrow"],
    ["the last second of tomorrow", thursday, "2026-10-02T23:59:59+02:00", "tomorrow"],
    ["the day after tomorrow", thursday, "2026-10-03T00:00:00+02:00", "week"],
    ["the last second of the week (Sunday)", thursday, "2026-10-04T23:59:59+02:00", "week"],
    ["next Monday at midnight", thursday, "2026-10-05T00:00:00+02:00", "later"],
    ["on a Saturday, Sunday is tomorrow", saturday, "2026-10-04T09:00:00+02:00", "tomorrow"],
    ["on a Saturday, Monday is later", saturday, "2026-10-05T09:00:00+02:00", "later"],
    ["on a Sunday, Monday is tomorrow (Sunday to Monday)", sunday, "2026-10-05T09:00:00+02:00", "tomorrow"],
    ["on a Sunday, Tuesday is later", sunday, "2026-10-06T09:00:00+02:00", "later"],
    ["on a Monday, Wednesday is this week", monday, "2026-10-07T09:00:00+02:00", "week"],
    ["on a Monday, Sunday is this week", monday, "2026-10-11T23:00:00+02:00", "week"],
    ["on a Monday, the next Monday is later", monday, "2026-10-12T00:00:00+02:00", "later"],
    // The clocks go back on Sunday 25 October: the day is 25 hours long.
    ["across the end of summer time", ms("2026-10-24T23:30:00+02:00"), "2026-10-25T23:30:00+01:00", "tomorrow"],
  ];

  it.each(table)("%s", (_label, now, at, bucket) => {
    expect(dayBucket(at, now, ZH)).toBe(bucket);
  });

  it("counts days in the time zone it is given", () => {
    // 22:30 UTC: already Friday in Zurich, still Thursday afternoon in New York.
    const now = ms("2026-10-01T08:00:00Z");
    const at = "2026-10-01T22:30:00Z";
    expect(dayBucket(at, now, ZH)).toBe("tomorrow");
    expect(dayBucket(at, now, "America/New_York")).toBe("today");
    // 23:30 UTC on Thursday is Friday in Tokyo too, but "now" there is Thursday.
    expect(dayBucket(at, now, "Asia/Tokyo")).toBe("tomorrow");
  });

  it("files an undated or unreadable row under later", () => {
    expect(dayBucket(null, thursday, ZH)).toBe("later");
    expect(dayBucket("not a date", thursday, ZH)).toBe("later");
  });
});

describe("groupByDay", () => {
  const now = ms("2026-10-01T10:00:00+02:00");
  const rows = [
    { id: "later", at: "2026-10-20T09:00:00+02:00" },
    { id: "undated", at: null },
    { id: "today-late", at: "2026-10-01T16:00:00+02:00" },
    { id: "today-early", at: "2026-10-01T13:00:00+02:00" },
    { id: "saturday", at: "2026-10-03T09:00:00+02:00" },
  ];

  it("draws the buckets in order, the soonest first, the undated last, empty buckets left out", () => {
    const groups = groupByDay(rows, (r) => r.at, now, ZH);
    expect(groups.map((g) => [g.bucket, g.rows.map((r) => r.id)])).toEqual([
      ["today", ["today-early", "today-late"]],
      ["week", ["saturday"]],
      ["later", ["later", "undated"]],
    ]);
  });

  it("is empty for no rows", () => {
    expect(groupByDay([], () => null, now, ZH)).toEqual([]);
  });

  it("keeps the input's order between rows of the same instant", () => {
    const same = [
      { id: "b", at: "2026-10-02T09:00:00+02:00" },
      { id: "a", at: "2026-10-02T09:00:00+02:00" },
    ];
    expect(groupByDay(same, (r) => r.at, now, ZH)[0]!.rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
