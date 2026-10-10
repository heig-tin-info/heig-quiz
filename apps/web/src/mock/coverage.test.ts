// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { coveredConceptIds, seedConceptIds } from "./concept";

describe("the mock's coverage (ADR-081 §4)", () => {
  it("covers a concept and its narrower ones, near or far", () => {
    const [pointer, dynamic, leak, array] = seedConceptIds(["Pointeur", "Allocation dynamique", "Fuite mémoire", "Tableau"]) as [
      string,
      string,
      string,
      string,
    ];
    expect(new Set(coveredConceptIds([pointer]))).toEqual(new Set([pointer, dynamic, leak, array]));
    expect(new Set(coveredConceptIds([dynamic]))).toEqual(new Set([dynamic, leak]));
    expect(coveredConceptIds([leak])).toEqual([leak]);
    expect(coveredConceptIds([])).toEqual([]);
  });
});
