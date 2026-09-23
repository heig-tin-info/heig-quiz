import { describe, expect, it } from "vitest";

import { breakdownOf, isLocked, markdown } from "./content.js";

describe("isLocked", () => {
  it("locks on readOnly or on disabled", () => {
    expect(isLocked(false, undefined)).toBe(false);
    expect(isLocked(false, false)).toBe(false);
    expect(isLocked(true, undefined)).toBe(true);
    expect(isLocked(false, true)).toBe(true);
  });
});

describe("markdown", () => {
  it("renders through the host when it lent a renderer, as text otherwise", () => {
    expect(markdown(undefined, "**x**")).toBe("**x**");
    expect(markdown((source) => `<${source}>`, "**x**")).toBe("<**x**>");
  });
});

describe("breakdownOf", () => {
  interface Details {
    cases: { ok: boolean }[];
    runner: string;
  }

  it("keeps a breakdown that carries its array", () => {
    const details: Details = { cases: [], runner: "ok" };
    expect(breakdownOf(details, "cases")).toBe(details);
  });

  it("refuses null and a grading-level marker", () => {
    expect(breakdownOf<Details>(null, "cases")).toBeNull();
    expect(breakdownOf<Details>(undefined, "cases")).toBeNull();
    const marker = { reason: "config_invalid" } as unknown as Details;
    expect(breakdownOf(marker, "cases")).toBeNull();
  });
});
