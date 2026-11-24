import { afterEach, describe, expect, it, vi } from "vitest";

import { createPainter, CURRENT_HIGHLIGHT, MATCH_HIGHLIGHT } from "./highlight";
import { findTextMatches } from "./search";

function article(html: string): HTMLElement {
  const el = document.createElement("article");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
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

describe("painting the matches with <mark> (no Custom Highlight API)", () => {
  it("wraps every match, marks the current one, and leaves the text whole when cleared", () => {
    const root = article("<p>gain <strong>ga</strong>in, again</p><p>no</p>");
    const before = root.innerHTML;
    const painter = createPainter(root, { marks: true });
    const ranges = painter.paint(findTextMatches(root, "gain"));
    expect(ranges).toHaveLength(3);
    // The second match spans <strong>: two marks for one match.
    expect(root.querySelectorAll(`mark.${MATCH_HIGHLIGHT}`)).toHaveLength(4);
    expect(root.textContent).toBe("gain gain, againno");
    painter.select(1);
    expect([...root.querySelectorAll(`mark.${CURRENT_HIGHLIGHT}`)].map((m) => m.textContent)).toEqual(["ga", "in"]);
    painter.select(2);
    expect([...root.querySelectorAll(`mark.${CURRENT_HIGHLIGHT}`)].map((m) => m.textContent)).toEqual(["gain"]);
    painter.clear();
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(root.innerHTML).toBe(before);
    // Whole text nodes again: a new search finds the same.
    expect(findTextMatches(root, "gain")).toHaveLength(3);
  });
});

describe("painting the matches with the Custom Highlight API", () => {
  class FakeHighlight {
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
    get size() {
      return this.ranges.length;
    }
  }

  it("registers the union of every viewer's ranges under the two names", () => {
    const registry = new Map<string, FakeHighlight>();
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", { ...globalThis.CSS, highlights: registry });
    const a = article("<p>gain gain</p>");
    const b = article("<p>gain</p>");
    const first = createPainter(a);
    const second = createPainter(b);
    first.paint(findTextMatches(a, "gain"));
    second.paint(findTextMatches(b, "gain"));
    expect(registry.get(MATCH_HIGHLIGHT)!.size).toBe(3);
    first.select(1);
    second.select(0);
    expect(registry.get(CURRENT_HIGHLIGHT)!.size).toBe(2);
    // Nothing of the rendered HTML changed.
    expect(a.innerHTML).toBe("<p>gain gain</p>");
    first.clear();
    expect(registry.get(MATCH_HIGHLIGHT)!.size).toBe(1);
    expect(registry.get(CURRENT_HIGHLIGHT)!.size).toBe(1);
  });
});
