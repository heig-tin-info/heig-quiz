import katex from "katex";
import { describe, expect, it } from "vitest";

import { forbiddenMacroDefinition, KATEX_LIMITS } from "./katex.js";

/** A formula as every renderer of the platform draws one. */
const render = (tex: string, displayMode = false) =>
  katex.renderToString(tex, { displayMode, throwOnError: true, ...KATEX_LIMITS });

/** A six-line aligned proof: what a long, legitimate formula costs in expansions (about 70). */
const LOGIC_PROOF = String.raw`\begin{aligned} (p \implies q) &\iff (\neg p \lor q) \\ &\iff (q \lor \neg p) \\ &\iff (\neg\neg q \lor \neg p) \\ &\iff (\neg q \implies \neg p) \\ x \neq y &\iff \neg(x = y) \\ f(x) &= \int_0^1 g(t)\,dt \neq 0 \end{aligned}`;

describe("KATEX_LIMITS (audit L15)", () => {
  it("leaves a long derivation room", () => {
    expect(render(LOGIC_PROOF, true)).toContain("katex-display");
  });

  it("refuses a formula past 500 expansions, even without a definition", () => {
    // 70 `\iff`, 8 expansions each: the belt behind the macro scan.
    expect(() => render(`x${" \\iff x".repeat(70)}`)).toThrow(/Too many expansions/);
  });

  it("renders the costliest 4 KB shapes without definitions in bounded time", () => {
    // ~110 ms each measured in Node; the bound leaves a loaded CI room.
    for (const [open, close, depth] of [["\\frac{", "}{x}", 409], ["\\overbrace{", "}^{a}", 255]] as const) {
      const tex = `${open.repeat(depth)}x${close.repeat(depth)}`;
      expect(tex.length).toBeLessThanOrEqual(4096);
      const start = performance.now();
      expect(render(tex)).toContain("katex-html");
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

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

  it("finds one whatever backslashes precede it, `\\verb` with `\\` as delimiter included", () => {
    expect(forbiddenMacroDefinition("\\verb\\!\\\\def\\a{x}\\a")).toBe("\\def");
    expect(forbiddenMacroDefinition("\\verb*\\q\\\\def\\a{x}\\a")).toBe("\\def");
    // So a line break followed by "def" is refused too: write it `\\ def`.
    expect(forbiddenMacroDefinition("a \\\\def")).toBe("\\def");
    expect(forbiddenMacroDefinition("a \\\\ def")).toBeNull();
  });

  it("leaves a longer control word alone", () => {
    expect(forbiddenMacroDefinition("\\defx + \\def@ + \\letter")).toBeNull();
    expect(forbiddenMacroDefinition("\\frac{a}{b} \\iff \\operatorname{let}")).toBeNull();
  });
});
