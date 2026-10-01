import { describe, expect, it } from "vitest";

import { similarityTerms } from "./similarityTerms.js";

describe("similarityTerms", () => {
  it("keeps the meaningful words, lower-cased, once, in their first order", () => {
    expect(similarityTerms("Quelle est la complexité d'un tri rapide ? Le tri rapide…")).toEqual([
      "complexité",
      "tri",
      "rapide",
    ]);
  });

  it("drops the short words and the English stop words too", () => {
    expect(similarityTerms("What is the output of printf(\"%d\", x++) in C?")).toEqual([
      "output",
      "printf",
    ]);
  });

  it("yields letters and digits only, so the terms join into a tsquery unescaped", () => {
    for (const term of similarityTerms("a|b & !c <-> 'drop' (table) x:* 2024 état")) {
      expect(term).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it("stops at `max`, and gives nothing for a statement of stop words only", () => {
    expect(similarityTerms("alpha beta gamma delta", 2)).toEqual(["alpha", "beta"]);
    expect(similarityTerms("Quel est le ? Which of the following")).toEqual([]);
  });
});
