import { describe, expect, it } from "vitest";

import { breakdownOf, markdown } from "./content.js";

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
