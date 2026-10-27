import { describe, expect, it } from "vitest";

import { endOfWeek } from "./dates";

// Local dates, read back with local getters: the same in every zone.
const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s);
const local = (iso: string) => {
  const d = new Date(iso);
  return [d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
};

describe("endOfWeek", () => {
  it("is the coming Sunday at 23:59", () => {
    expect(local(endOfWeek(at(2, 9, 0)))).toEqual([8, 23, 59, 0]); // Monday
    expect(local(endOfWeek(at(4, 15, 30)))).toEqual([8, 23, 59, 0]); // Wednesday
    expect(local(endOfWeek(at(7, 23, 59)))).toEqual([8, 23, 59, 0]); // Saturday night
  });

  it("is today on a Sunday, the next Sunday once 23:59 has passed", () => {
    expect(local(endOfWeek(at(8, 8, 0)))).toEqual([8, 23, 59, 0]);
    expect(local(endOfWeek(at(8, 23, 58, 59)))).toEqual([8, 23, 59, 0]);
    expect(local(endOfWeek(at(8, 23, 59, 30)))).toEqual([15, 23, 59, 0]);
  });
});
