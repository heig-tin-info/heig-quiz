import { describe, expect, it } from "vitest";
import { isBatchable } from "./batchable.js";

describe("isBatchable (F-GRADE-04)", () => {
  it("takes a proposal that carries an opinion: points, or a stated confidence", () => {
    expect(isBatchable({ state: "proposed", points: 1.5, confidence: null })).toBe(true);
    expect(isBatchable({ state: "proposed", points: 0, confidence: "high" })).toBe(true);
  });

  it("leaves a 0-point placeholder without confidence to a person (an essay, #192)", () => {
    expect(isBatchable({ state: "proposed", points: 0, confidence: null })).toBe(false);
  });

  it("never takes what is not a proposal", () => {
    expect(isBatchable({ state: "validated", points: 2, confidence: "high" })).toBe(false);
    expect(isBatchable({ state: "superseded", points: 2, confidence: null })).toBe(false);
  });
});
