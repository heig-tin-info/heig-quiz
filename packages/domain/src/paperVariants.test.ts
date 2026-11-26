import { describe, expect, it } from "vitest";

import { MAX_PAPER_VARIANTS, paperVariantsLock, variantCountRefusal, variantLetter, variesOnPaper } from "./paperVariants.js";

describe("paper variants (ADR-148)", () => {
  it("letters variants A to Z by their number", () => {
    expect(variantLetter(1)).toBe("A");
    expect(variantLetter(3)).toBe("C");
    expect(variantLetter(MAX_PAPER_VARIANTS)).toBe("Z");
  });

  it("locks once the evaluation opened, or a paper copy exists", () => {
    expect(paperVariantsLock(null, 0)).toBeNull();
    expect(paperVariantsLock(new Date(), 0)).toBe("opened");
    expect(paperVariantsLock("2026-11-26T08:00:00.000Z", 3)).toBe("opened");
    expect(paperVariantsLock(null, 1)).toBe("paper_copy");
  });

  it("varies with shuffled items, shuffled choices or a parameterized question", () => {
    const none = { shuffleItems: false, shuffleChoices: false };
    expect(variesOnPaper(none, false)).toBe(false);
    expect(variesOnPaper({ ...none, shuffleItems: true }, false)).toBe(true);
    expect(variesOnPaper({ ...none, shuffleChoices: true }, false)).toBe(true);
    expect(variesOnPaper(none, true)).toBe(true);
  });

  it("refuses identical variants, and fewer once locked; raising stays allowed", () => {
    expect(variantCountRefusal(1, 2, { varies: false, lock: null })).toBe("variants_identical");
    expect(variantCountRefusal(3, 1, { varies: false, lock: null })).toBeNull();
    expect(variantCountRefusal(3, 2, { varies: true, lock: "opened" })).toBe("variants_locked");
    expect(variantCountRefusal(3, 4, { varies: true, lock: "paper_copy" })).toBeNull();
    expect(variantCountRefusal(3, 3, { varies: true, lock: "opened" })).toBeNull();
  });
});
