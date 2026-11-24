import { afterEach, describe, expect, it } from "vitest";

import { findTextMatches, foldQuery, foldText, matchOffsets } from "./search";

function article(html: string): HTMLElement {
  const el = document.createElement("article");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

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

describe("finding matches in a rendered document", () => {
  it("finds a match across inline elements, folded", () => {
    const root = article("<p>Une <em>Rés</em>istance et une resistance.</p>");
    const matches = findTextMatches(root, "résistance");
    expect(matches).toHaveLength(2);
    expect(matches[0]!.map((s) => [s.node.data.slice(s.start, s.end)])).toEqual([["Rés"], ["istance"]]);
    expect(matches[1]!).toHaveLength(1);
  });

  it("searches the visible copy of a formula, not its MathML", () => {
    const root = article('<p><span class="katex"><span class="katex-mathml">gain</span><span class="katex-html">G</span></span> gain</p>');
    expect(findTextMatches(root, "gain")).toHaveLength(1);
  });

  it("finds nothing for a blank query", () => {
    expect(findTextMatches(article("<p>a b</p>"), "  ")).toEqual([]);
  });
});
