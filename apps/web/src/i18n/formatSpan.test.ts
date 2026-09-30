import { describe, expect, it } from "vitest";

import { en } from "./en";
import { formatBytes, formatMs, formatSpan, type TFunction } from "./index";

const t: TFunction = (key, vars) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

/** The expected text, spaces made non-breaking as `formatSpan` writes them. */
const nb = (text: string) => text.replace(/ /g, "\u00a0");

describe("formatSpan", () => {
  it("writes seconds, minutes and seconds, or hours and minutes", () => {
    expect(formatSpan(0, t)).toBe(nb("0 s"));
    expect(formatSpan(45, t)).toBe(nb("45 s"));
    expect(formatSpan(80, t)).toBe(nb("1 min 20 s"));
    expect(formatSpan(125, t)).toBe(nb("2 min 05 s"));
    expect(formatSpan(3599, t)).toBe(nb("59 min 59 s"));
    expect(formatSpan(4320, t)).toBe(nb("1 h 12 min"));
  });

  it("rounds to the second and never goes below zero", () => {
    expect(formatSpan(59.6, t)).toBe(nb("1 min 00 s"));
    expect(formatSpan(-3, t)).toBe(nb("0 s"));
  });
});

describe("formatMs", () => {
  it("writes milliseconds under a second, then a span", () => {
    expect(formatMs(2.4, t)).toBe("2 ms");
    expect(formatMs(999, t)).toBe("999 ms");
    expect(formatMs(95_000, t)).toBe(nb("1 min 35 s"));
  });
});

describe("formatBytes", () => {
  it("picks the decimal unit, one decimal under ten", () => {
    expect(formatBytes(940, "en")).toBe("940 byte");
    expect(formatBytes(4_100_000_000, "en")).toBe("4.1 GB");
    expect(formatBytes(61_200_000, "en")).toBe("61 MB");
    expect(formatBytes(4_100_000_000, "fr")).toMatch(/^4,1\s?Go$/);
  });
});
