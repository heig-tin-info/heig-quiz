import { describe, expect, it } from "vitest";

import { addZonedDays, zonedIso, zoneOffset } from "./zone.js";

describe("addZonedDays", () => {
  it("keeps the local time across a change of the clocks, either way", () => {
    // 12:00 summer time on 24 October 2026, +2 days: 12:00 winter time, 49 h later.
    expect(addZonedDays(new Date("2026-10-24T10:00:00Z"), 2)).toEqual(new Date("2026-10-26T11:00:00Z"));
    expect(addZonedDays(new Date("2026-10-26T11:00:00Z"), -2)).toEqual(new Date("2026-10-24T10:00:00Z"));
    expect(addZonedDays(new Date("2026-07-01T10:00:00Z"), 0)).toEqual(new Date("2026-07-01T10:00:00Z"));
  });

  it("keeps the milliseconds and counts in the zone it is given", () => {
    expect(addZonedDays(new Date("2026-10-24T10:00:00.250Z"), 2, "UTC")).toEqual(new Date("2026-10-26T10:00:00.250Z"));
  });
});

describe("zonedIso", () => {
  it("formats a summer instant with the +02:00 offset", () => {
    // 2026-07-03T21:59:00Z = 23:59 summer time in Zurich.
    expect(zonedIso(new Date("2026-07-03T21:59:00Z"))).toBe("2026-07-03T23:59:00+02:00");
  });

  it("formats a winter instant with the +01:00 offset", () => {
    expect(zonedIso(new Date("2026-01-15T11:00:00Z"))).toBe("2026-01-15T12:00:00+01:00");
  });

  it("crosses the date boundary through the offset", () => {
    // 23:30 UTC on the 1st = 01:30 on the 2nd in Zurich (summer).
    expect(zonedIso(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02T01:30:00+02:00");
  });

  it("drops the milliseconds", () => {
    expect(zonedIso(new Date("2026-07-03T21:59:00.999Z"))).toBe("2026-07-03T23:59:00+02:00");
  });
});

describe("zoneOffset", () => {
  it("is zero in UTC and negative west of it, half hours included", () => {
    const at = new Date("2026-01-15T11:00:00Z");
    expect(zoneOffset(at, "UTC")).toBe(0);
    expect(zoneOffset(at, "America/St_Johns")).toBe(-(3 * 60 + 30) * 60_000);
  });
});
