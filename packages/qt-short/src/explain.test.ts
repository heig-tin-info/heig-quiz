import { describe, expect, it } from "vitest";

import { explainMatcher, formatNumber } from "./explain.js";
import type { ShortMatcher } from "./schema.js";
import { shortEditorStrings as s } from "./strings.js";

const number = (over: Partial<Extract<ShortMatcher, { kind: "number" }>> = {}): ShortMatcher => ({
  kind: "number",
  value: 9.81,
  tolerance: 0,
  toleranceMode: "abs",
  unitRequired: false,
  points: 1,
  ...over,
});

describe("formatNumber", () => {
  it("drops the float noise", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(9.81 * 0.99)).toBe("9.7119");
    expect(formatNumber(-3)).toBe("-3");
  });
});

describe("explainMatcher — number", () => {
  it("says exactly when there is no tolerance", () => {
    expect(explainMatcher(number(), s)).toBe("Accepts exactly 9.81.");
  });

  it("writes an absolute tolerance after the value, the unit last", () => {
    expect(explainMatcher(number({ tolerance: 0.05, unit: "m/s²", unitRequired: true }), s)).toBe(
      "Accepts 9.81 ± 0.05 m/s². The unit m/s² is required.",
    );
  });

  it("says when the unit may be omitted", () => {
    expect(explainMatcher(number({ tolerance: 0.05, unit: "m/s²" }), s)).toBe(
      "Accepts 9.81 ± 0.05 m/s². The unit m/s² may be omitted.",
    );
  });

  it("writes a relative tolerance in percent, with the interval it opens", () => {
    expect(explainMatcher(number({ tolerance: 0.01, toleranceMode: "rel" }), s)).toBe(
      "Accepts 9.81 ± 1 %, from 9.7119 to 9.9081.",
    );
  });

  it("keeps the interval ordered for a negative value", () => {
    expect(explainMatcher(number({ value: -10, tolerance: 0.1, toleranceMode: "rel" }), s)).toBe(
      "Accepts -10 ± 10 %, from -11 to -9.",
    );
  });

  it("ignores unitRequired when there is no unit to require", () => {
    expect(explainMatcher(number({ unitRequired: true, unit: " " }), s)).toBe(
      "Accepts exactly 9.81.",
    );
  });

  it("says nothing about a value that is not a number", () => {
    expect(explainMatcher(number({ value: Number.NaN }), s)).toBeNull();
  });
});

describe("explainMatcher — date", () => {
  const date = (value: string, toleranceDays: number): ShortMatcher => ({
    kind: "date",
    value,
    toleranceDays,
    points: 1,
  });

  it("names the one day when there is no tolerance", () => {
    expect(explainMatcher(date("2026-09-20", 0), s)).toBe("Accepts 2026-09-20 only.");
  });

  it("opens the interval across a month and a year", () => {
    expect(explainMatcher(date("2027-01-01", 2), s)).toBe(
      "Accepts 2026-12-30 to 2027-01-03 (2027-01-01 ± 2 days).",
    );
  });

  it("uses the singular for one day", () => {
    expect(explainMatcher(date("2026-03-01", 1), s)).toBe(
      "Accepts 2026-02-28 to 2026-03-02 (2026-03-01 ± 1 day).",
    );
  });

  it("says nothing before a date is picked", () => {
    expect(explainMatcher(date("", 3), s)).toBeNull();
  });
});

describe("explainMatcher — time", () => {
  const time = (value: string, toleranceMinutes: number): ShortMatcher => ({
    kind: "time",
    value,
    toleranceMinutes,
    points: 1,
  });

  it("names the one minute when there is no tolerance", () => {
    expect(explainMatcher(time("14:05", 0), s)).toBe("Accepts 14:05 only.");
  });

  it("opens the interval in minutes", () => {
    expect(explainMatcher(time("14:05", 10), s)).toBe("Accepts 13:55 to 14:15 (14:05 ± 10 minutes).");
    expect(explainMatcher(time("14:05", 1), s)).toBe("Accepts 14:04 to 14:06 (14:05 ± 1 minute).");
  });

  it("does not wrap past midnight, like the matcher", () => {
    expect(explainMatcher(time("23:50", 20), s)).toBe("Accepts 23:30 to 23:59 (23:50 ± 20 minutes).");
    expect(explainMatcher(time("00:05", 30), s)).toBe("Accepts 00:00 to 00:35 (00:05 ± 30 minutes).");
  });

  it("says nothing before a time is typed", () => {
    expect(explainMatcher(time("", 5), s)).toBeNull();
  });
});

describe("explainMatcher — the other kinds", () => {
  it("has nothing to explain", () => {
    expect(explainMatcher({ kind: "exact", value: "x", points: 1 }, s)).toBeNull();
    expect(explainMatcher({ kind: "regex", pattern: "x", flags: "i", points: 1 }, s)).toBeNull();
  });
});
