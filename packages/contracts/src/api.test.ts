import { describe, expect, it } from "vitest";

import { DATE_FORMATS, isDateFormat } from "./api.js";

describe("isDateFormat", () => {
  it("accepts every format the list declares", () => {
    for (const format of DATE_FORMATS) expect(isDateFormat(format)).toBe(true);
  });

  it("rejects a string that is not one of them", () => {
    expect(isDateFormat("fr")).toBe(false);
    expect(isDateFormat("")).toBe(false);
  });

  it("rejects anything that is not a string, so a stored null falls back to ISO", () => {
    expect(isDateFormat(null)).toBe(false);
    expect(isDateFormat(undefined)).toBe(false);
    expect(isDateFormat(0)).toBe(false);
    expect(isDateFormat(["iso"])).toBe(false);
  });
});
