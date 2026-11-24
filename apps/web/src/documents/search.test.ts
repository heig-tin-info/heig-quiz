import { describe, expect, it } from "vitest";

import { foldQuery, foldText, matchOffsets } from "./search";

describe("folding a text for search", () => {
  it("ignores case and accents", () => {
    expect(foldText("Résistance ÉLEVÉE")).toBe("resistance elevee");
    expect(foldText("Ça, où, naïve, Größe")).toBe("ca, ou, naive, große");
  });

  it("reads every kind of space as one, and the typographic apostrophe as the straight one", () => {
    // docrender puts a narrow no-break space before a French colon.
    expect(foldText("a : b c\nd\te")).toBe("a : b c d e");
    expect(foldText("l’entrée")).toBe("l'entree");
  });

  it("keeps one unit for one unit, so an offset in the folded text is an offset in the DOM", () => {
    for (const text of ["İstanbul", "ﬁn", "a😀b", "Å Ω µ ß", "x́y"]) {
      expect(foldText(text)).toHaveLength(text.length);
    }
    // The emoji's two halves stay as they are.
    expect(foldText("a😀b")).toBe("a😀b");
  });

  it("trims the query, and an empty one finds nothing", () => {
    expect(foldQuery("  Gain ")).toBe("gain");
    expect(foldQuery("   ")).toBe("");
    expect(matchOffsets("abc", "")).toEqual([]);
  });
});

describe("finding the matches", () => {
  it("finds every match, left to right, never overlapping", () => {
    expect(matchOffsets("gain, gain and again", "gain")).toEqual([0, 6, 16]);
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(matchOffsets("nothing here", "gain")).toEqual([]);
  });
});
