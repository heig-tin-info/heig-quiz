import { describe, expect, it } from "vitest";

import { frenchSpacing, NNBSP } from "./typography.js";

/** The expected text, with `_` standing for U+202F. */
const n = (s: string) => s.replace(/_/g, NNBSP);

describe("frenchSpacing", () => {
  it.each([
    ["mot :", "mot_:"],
    ["mot ;", "mot_;"],
    ["mot !", "mot_!"],
    ["mot ?", "mot_?"],
    ["« mot »", "«_mot_»"],
    ["«mot»", "«mot»"],
    ["« »", "«_»"],
    ["mot ?!", "mot_?!"],
  ])("spaces %j", (source, expected) => {
    expect(frenchSpacing(source)).toBe(n(expected));
  });

  it("takes a soft line break for the space it reads as", () => {
    expect(frenchSpacing("mot\n:")).toBe(n("mot_:"));
    expect(frenchSpacing("mot \n : suite")).toBe(n("mot_: suite"));
    expect(frenchSpacing("«\nmot")).toBe(n("«_mot"));
  });

  it("never adds a space the author did not write", () => {
    for (const s of ["mot:", "10:30", "a;b", "Hello!", "why?", "https://x.ch/?a=1", ""]) {
      expect(frenchSpacing(s)).toBe(s);
    }
  });

  it("collapses a run of spaces and tabs into one", () => {
    expect(frenchSpacing("mot   :")).toBe(n("mot_:"));
    expect(frenchSpacing("mot \t ;")).toBe(n("mot_;"));
    expect(frenchSpacing("«   mot")).toBe(n("«_mot"));
  });

  it("normalises a no-break space already there to the narrow one", () => {
    expect(frenchSpacing("mot :")).toBe(n("mot_:"));
    expect(frenchSpacing("mot :")).toBe(n("mot_:"));
    expect(frenchSpacing("« mot »")).toBe(n("«_mot_»"));
  });

  it("spaces a run at the very start, which follows the token before it", () => {
    expect(frenchSpacing(" : la suite")).toBe(n("_: la suite"));
  });

  it("leaves the spaces elsewhere alone", () => {
    expect(frenchSpacing("un mot, puis : deux")).toBe(n("un mot, puis_: deux"));
    expect(frenchSpacing("a\n\nb")).toBe("a\n\nb");
  });

  it("stays linear on a long run of spaces", () => {
    const start = performance.now();
    frenchSpacing(`a${" ".repeat(100_000)}b`);
    frenchSpacing(`a${" \n".repeat(50_000)}b`);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
