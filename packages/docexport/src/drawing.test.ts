import { describe, expect, it } from "vitest";

import { DRAWING_LIMITS, toSvg, xmlText, type Drawing, type DrawingItem } from "./drawing.js";

const box = (items: readonly DrawingItem[]): Drawing => ({ viewBox: [0, 0, 100, 50], items });
const dot: DrawingItem = { kind: "ellipse", cx: 0, cy: 0, rx: 1, ry: 1 };

/** The SVG of `drawing`, or a failed test. */
function svgOf(drawing: Drawing, greyed = false): string {
  const out = toSvg(drawing, { greyed });
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.svg;
}

/** Nothing an SVG could run, link, load or restyle from (ADR-126 §2). */
const FORBIDDEN = [/class=/i, /\sstyle=/i, /href/i, /<image/i, /foreignObject/i, /<script/i, /url\(/i, /<!/, /<\?/, /\bon\w+=/i, /<use/i];

describe("toSvg", () => {
  it("writes every item kind from the closed model, colours literal, text in the embedded mono font", () => {
    const svg = svgOf({
      viewBox: [0, 0, 200, 100],
      items: [
        { kind: "path", d: "M0 0 L10 10 Z", fill: "faint" },
        { kind: "rect", x: 1, y: 2, w: 3, h: 4, rx: 1, stroke: "grey", width: 0.5, dash: [2, 1] },
        { kind: "ellipse", cx: 5, cy: 5, rx: 2, ry: 1, fill: "ink", stroke: "none" },
        { kind: "line", x1: 0, y1: 0, x2: 1.23456, y2: -0 },
        { kind: "text", x: 10, y: 20, text: "R1", anchor: "middle", baseline: "middle", size: 8, weight: "bold", italic: true },
        { kind: "g", transform: [1, 0, 0, 1, 10, 20], opacity: 0.4, items: [{ kind: "text", x: 0, y: 0, text: "in" }] },
      ],
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">' +
        '<path d="M0 0 L10 10 Z" stroke="#000000" stroke-width="1" fill="#d2d2d2"/>' +
        '<rect x="1" y="2" width="3" height="4" rx="1" stroke="#8c8c8c" stroke-width="0.5" fill="none" stroke-dasharray="2 1"/>' +
        '<ellipse cx="5" cy="5" rx="2" ry="1" stroke="none" stroke-width="1" fill="#000000"/>' +
        '<line x1="0" y1="0" x2="1.235" y2="0" stroke="#000000" stroke-width="1"/>' +
        '<text x="10" y="20" font-family="DejaVu Sans Mono" font-size="8" fill="#000000" text-anchor="middle" dominant-baseline="central" font-weight="bold" font-style="italic">R1</text>' +
        '<g transform="matrix(1 0 0 1 10 20)" opacity="0.4"><text x="0" y="0" font-family="DejaVu Sans Mono" font-size="12" fill="#000000">in</text></g>' +
        "</svg>",
    );
    for (const token of FORBIDDEN) expect(svg).not.toMatch(token);
  });

  it("escapes a text, so no producer string becomes markup", () => {
    const hostile = `</text><image href="x"/><foreignObject><script>alert(1)</script>&amp; "q" 'a' \u0000\u001f`;
    const svg = svgOf(box([{ kind: "text", x: 0, y: 0, text: hostile }]));
    expect(svg).toContain(
      "&#60;/text&#62;&#60;image href=&#34;x&#34;/&#62;&#60;foreignObject&#62;&#60;script&#62;alert(1)&#60;/script&#62;&#38;amp; &#34;q&#34; &#39;a&#39; </text>",
    );
    expect(svg.match(/</g)).toHaveLength(4);
    expect(xmlText("a\ud800b")).toBe("ab");
    expect(xmlText("😀")).toBe("😀");
  });

  it("refuses path data outside its grammar, or holding a number past the cap", () => {
    for (const d of ['M0 0"/><image href="x', "M0 0 url(#a)", "M0 0;", "M0\n0"]) {
      expect(toSvg(box([{ kind: "path", d }]))).toEqual({ ok: false, reason: "path" });
    }
    for (const d of ["M0 0 L2000000 0", "M1e7 0", "M0 0 L-1.5e+6,0", "M1e999 0"]) {
      expect(toSvg(box([{ kind: "path", d }]))).toEqual({ ok: false, reason: "value" });
    }
    expect(toSvg(box([{ kind: "path", d: "m1.5e-3,2E+2 h3 v-4 c1 2 3 4 5 6 s1 2 3 4 q1 2 3 4 t1 2 a1 1 0 0 1 2 2 z" }])).ok).toBe(true);
  });

  it("refuses a number that is not finite, or past the cap", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY, 2e6]) {
      expect(toSvg(box([{ kind: "ellipse", cx: bad, cy: 0, rx: 1, ry: 1 }]))).toEqual({ ok: false, reason: "value" });
      expect(toSvg(box([{ kind: "line", x1: 0, y1: 0, x2: 1, y2: 1, width: bad }]))).toEqual({ ok: false, reason: "value" });
      expect(toSvg(box([{ kind: "g", transform: [1, 0, 0, 1, bad, 0], items: [] }]))).toEqual({ ok: false, reason: "value" });
    }
    expect(toSvg({ viewBox: [0, 0, 0, 10], items: [] })).toEqual({ ok: false, reason: "viewBox" });
    expect(toSvg({ viewBox: [0, 0, 0.0001, 10], items: [] })).toEqual({ ok: false, reason: "viewBox" });
    expect(toSvg({ viewBox: [0, 0, Number.NaN, 10], items: [] })).toEqual({ ok: false, reason: "viewBox" });
  });

  it("refuses nested transforms whose composition passes the cap, or collapses", () => {
    const nest = (m: readonly [number, number, number, number, number, number], n: number): DrawingItem => {
      let it: DrawingItem = dot;
      for (let i = 0; i < n; i++) it = { kind: "g", transform: m, opacity: 0.5, items: [it] };
      return it;
    };
    // Each factor is within the cap; their product is not (it once crashed Typst, ADR-126 §2).
    expect(toSvg(box([nest([1e6, 0, 0, 1e6, 0, 0], 1)])).ok).toBe(true);
    expect(toSvg(box([nest([1e6, 0, 0, 1e6, 0, 0], 2)]))).toEqual({ ok: false, reason: "value" });
    expect(toSvg(box([nest([1e3, 0, 0, 1e3, 1e3, 0], 3)]))).toEqual({ ok: false, reason: "value" });
    // A shrink that leaves nothing to invert.
    expect(toSvg(box([nest([1e-3, 0, 0, 1e-3, 0, 0], 3)]))).toEqual({ ok: false, reason: "value" });
    expect(toSvg(box([nest([2, 0, 0, 2, 0, 0], 6)])).ok).toBe(true);
  });

  it("refuses a value outside the closed model, never with a TypeError", () => {
    const cast = (item: unknown) => toSvg(box([item as DrawingItem]));
    expect(cast({ kind: "rect", x: 0, y: 0, w: 1, h: 1, fill: "red" })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "rect", x: 0, y: 0, w: 1, h: 1, fill: "toString" })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "rect", x: 0, y: 0, w: 1, h: 1, dash: "1 2" })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "g", transform: "scale(9)", items: [] })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "g", items: "x" })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "image", href: "x" })).toEqual({ ok: false, reason: "value" });
    expect(cast({ kind: "text", x: 0, y: 0, text: 3 }).ok).toBe(false);
    expect(toSvg({ viewBox: "0 0 1 1", items: [] } as unknown as Drawing)).toEqual({ ok: false, reason: "viewBox" });
  });

  it("clamps an opacity, a width and a size into range", () => {
    const svg = svgOf(box([{ kind: "g", opacity: 4, items: [{ kind: "rect", x: 0, y: 0, w: -3, h: 1, width: -1 }] }]));
    expect(svg).toContain('width="0" height="1"');
    expect(svg).toContain('stroke-width="0"');
    expect(svg).toContain('opacity="1"');
  });

  it("refuses a drawing past its size caps, and a nesting past its depth", () => {
    const many = Array.from({ length: DRAWING_LIMITS.items + 1 }, (): DrawingItem => dot);
    expect(toSvg(box(many))).toEqual({ ok: false, reason: "size" });
    expect(toSvg(box([{ kind: "text", x: 0, y: 0, text: "x".repeat(DRAWING_LIMITS.text + 1) }]))).toEqual({ ok: false, reason: "size" });
    expect(toSvg(box([{ kind: "path", d: "M".repeat(DRAWING_LIMITS.path + 1) }]))).toEqual({ ok: false, reason: "size" });
    let nested: DrawingItem = dot;
    for (let i = 0; i <= DRAWING_LIMITS.depth; i++) nested = { kind: "g", items: [nested] };
    expect(toSvg(box([nested]))).toEqual({ ok: false, reason: "depth" });
    const texts = Array.from({ length: 1500 }, (): DrawingItem => ({ kind: "text", x: 0, y: 0, text: "y".repeat(400) }));
    expect(toSvg(box(texts))).toEqual({ ok: false, reason: "size" });
  });

  it("greys every ink of a starter, and only ink", () => {
    const svg = svgOf(box([{ kind: "rect", x: 0, y: 0, w: 1, h: 1, fill: "paper" }, { kind: "text", x: 0, y: 0, text: "s" }]), true);
    expect(svg).not.toContain("#000000");
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#8c8c8c"');
  });
});
