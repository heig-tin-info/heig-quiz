import { describe, expect, it } from "vitest";

import { en } from "./en";
import { formatSpan, type TFunction } from "./index";

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
