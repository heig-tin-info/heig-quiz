import { describe, expect, it } from "vitest";

import { forbiddenMacroDefinition } from "./katex.js";

describe("forbiddenMacroDefinition (audit L15)", () => {
  it("names every command that defines or aliases a macro", () => {
    for (const name of [
      "def", "gdef", "edef", "xdef", "let", "futurelet",
      "newcommand", "renewcommand", "providecommand", "global",
    ]) {
      expect(forbiddenMacroDefinition(`x + \\${name}\\a{y}`)).toBe(`\\${name}`);
    }
  });

  it("finds one after a prefix or inside a group", () => {
    expect(forbiddenMacroDefinition("\\long\\def\\a{x}")).toBe("\\def");
    expect(forbiddenMacroDefinition("{a^{\\gdef\\b{c}}}")).toBe("\\gdef");
  });

  it("reads control sequences as KaTeX does: a longer word, or `\\\\` then letters, is not one", () => {
    expect(forbiddenMacroDefinition("a \\\\def")).toBeNull();
    expect(forbiddenMacroDefinition("\\defx + \\def@ + \\letter")).toBeNull();
    expect(forbiddenMacroDefinition("\\frac{a}{b} \\iff \\operatorname{let}")).toBeNull();
  });
});
