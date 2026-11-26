import { describe, expect, it } from "vitest";

import { MAX_PAPER_VARIANTS, paperVariantsLocked, variantCountRefusal, variantLetter, variesOnPaper } from "./paperVariants.js";

describe("paper variants (ADR-148)", () => {
  it("letters variants A to Z by their number", () => {
    expect(variantLetter(1)).toBe("A");
    expect(variantLetter(3)).toBe("C");
    expect(variantLetter(MAX_PAPER_VARIANTS)).toBe("Z");
  });

  it("fixes them from the opening on, the lobby included, as the questions are", () => {
    expect(paperVariantsLocked("draft")).toBe(false);
    expect(paperVariantsLocked("scheduled")).toBe(false);
    for (const state of ["lobby", "running", "paused", "closed", "grading", "released"] as const) {
      expect(paperVariantsLocked(state)).toBe(true);
    }
  });

  it("varies with shuffled items, shuffled choices or a parameterized question", () => {
    const none = { shuffleItems: false, shuffleChoices: false };
    expect(variesOnPaper(none, false)).toBe(false);
    expect(variesOnPaper({ ...none, shuffleItems: true }, false)).toBe(true);
    expect(variesOnPaper({ ...none, shuffleChoices: true }, false)).toBe(true);
    expect(variesOnPaper(none, true)).toBe(true);
  });

  it("refuses identical variants, and fewer once locked; raising stays allowed", () => {
    expect(variantCountRefusal(1, 2, { varies: false, locked: false })).toBe("variants_identical");
    expect(variantCountRefusal(3, 1, { varies: false, locked: false })).toBeNull();
    expect(variantCountRefusal(3, 2, { varies: true, locked: true })).toBe("variants_locked");
    expect(variantCountRefusal(3, 4, { varies: true, locked: true })).toBeNull();
    expect(variantCountRefusal(3, 3, { varies: true, locked: true })).toBeNull();
  });
});
