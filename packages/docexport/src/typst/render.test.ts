import { describe, expect, it } from "vitest";

import { answerZone, code, drawing, heading, list, markdown, points, scopeZones, separator, table, tests, type Block, type Document } from "../document.js";
import { EN_LABELS, FR_LABELS, type Lang } from "../labels.js";
import { renderTypst } from "./render.js";
import { BODY_FONT, MARGIN_MM, MONO_FONT } from "./template.js";

const provenance = {
  kind: "handout",
  version: 1,
  source: { evaluationId: "e1" },
  attempts: ["a1"],
  generatedAt: "2026-11-04T10:00:00.000Z",
  app: null,
};

const doc = (blocks: readonly Block[], lang: Lang = "en"): Document => ({ provenance, lang, blocks });

/** The body of the source: what follows the provenance metadata. */
const bodyOf = (source: string) => source.split("<provenance>\n\n")[1]!;

describe("renderTypst", () => {
  it("sets the page: A4, margins of at least 20 mm, the embedded fonts, the language, the title and the PDF metadata", () => {
    const { source } = renderTypst(doc([heading(1, 'Exam "one" #1')], "fr"));
    expect(MARGIN_MM).toBeGreaterThanOrEqual(20);
    expect(source).toContain('#set page(paper: "a4", margin: 20mm,');
    expect(source).toContain(`#set text(font: "${BODY_FONT}", size: 11pt, lang: "fr")`);
    expect(source).toContain(`#show raw: set text(font: "${MONO_FONT}"`);
    expect(source).toContain('#set document(title: "Exam \\"one\\" #1", author: "Quiz")');
    expect(source).toContain('counter(page).display("1 / 1", both: true)');
    expect(source).toContain(
      '#metadata(("export": ("kind": "handout", "format": "pdf", "version": 1), "source": ("evaluationId": "e1"), "attempts": ("a1",), "generatedAt": "2026-11-04T10:00:00.000Z", "app": none)) <provenance>',
    );
  });

  it("maps every block kind", () => {
    const { source } = renderTypst(
      doc([
        heading(2, "Question 1: #x"),
        markdown("A **b**."),
        code("c", "int main(void);\n"),
        list(["one", "two #"]),
        table(["Blank", "Expected"], [["(1)", "a|b"]]),
        tests([{ name: "hidden-one", visible: false, ok: true, points: 3 }]),
        points(1.5, 2),
        points(null, 2),
        separator,
      ]),
    );
    expect(bodyOf(source)).toBe(
      [
        "#heading(level: 2)[Question 1: \\#x]",
        "A #strong[b]\\.",
        '#raw(block: true, lang: "c", "int main(void);")',
        "#list([one], [two \\#])",
        '#table(columns: 2,\n  table.header([#strong[Blank]], [#strong[Expected]]),\n  [(1)], [a|b],\n)',
        "Tests passed: 1/1\n\n" +
          '#table(columns: 4,\n  table.header([#strong[Test]], [#strong[Visibility]], [#strong[Result]], [#strong[Points]]),\n  [hidden\\-one], [hidden], [passed], [3],\n)',
        "Points: 1\\.5 \\/ 2",
        "Points: not graded \\/ 2",
        "#hr",
        "",
      ].join("\n\n"),
    );
  });

  it("keys every answer zone for the manifest, with its shape", () => {
    const blocks = [
      answerZone("name"),
      ...scopeZones("item-1", [answerZone("bubbles", { labels: ["A", "B", 'C "x"'] })]),
      ...scopeZones("item-2", [answerZone("bubbles", { labels: ["A"], multiple: true })]),
      ...scopeZones("item-3", [answerZone("lines", { part: "b0", lines: 2 }), answerZone("lines", { part: "b1" })]),
      ...scopeZones("item-4", [answerZone("free", { heightMm: 60 })]),
    ].map((b) => (b.kind === "answerZone" && b.zone === "name" ? { ...b, id: "name" } : b));
    const { source } = renderTypst(doc(blocks));
    const zones = bodyOf(source).split("\n\n");
    expect(zones).toEqual([
      '#zone("name", "name", names("Name", "First name"))',
      '#zone("item-1", "bubbles", bubbles(("A", "B", "C \\"x\\""), false))',
      '#zone("item-2", "bubbles", bubbles(("A",), true))',
      '#zone("item-3:b0", "lines", lines(2))',
      '#zone("item-3:b1", "lines", lines(1))',
      '#zone("item-4", "free", free(60mm))',
      "",
    ]);
    // The preamble's zone records each one under the label `query(<answer-zone>)` reads, through `typst eval`.
    expect(source).toContain("<answer-zone>");
    expect(source).toContain("#let zone(id, kind, body)");
  });

  it("draws a figure as its SVG inline, sized in millimetres, and its alt text when the SVG is refused", () => {
    const figure = { viewBox: [0, 0, 40, 25] as const, items: [{ kind: "text" as const, x: 1, y: 2, text: 'R "1"' }] };
    const body = bodyOf(renderTypst(doc([drawing(figure, "Two resistors", { widthMm: 160 })])).source);
    expect(body).toBe(
      '#figsvg("<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 40 25\\" width=\\"40\\" height=\\"25\\">' +
        '<text x=\\"1\\" y=\\"2\\" font-family=\\"DejaVu Sans Mono\\" font-size=\\"12\\" fill=\\"#000000\\">R &#34;1&#34;</text></svg>", "Two resistors", 160)\n\n',
    );
    // One pixel per unit by default, never past the 170 mm column.
    expect(bodyOf(renderTypst(doc([drawing({ viewBox: [0, 0, 2000, 10], items: [] }, "wide")])).source)).toContain(", 170)");
    const refused = drawing({ viewBox: [0, 0, 10, 10], items: [{ kind: "path", d: "M0 0 url(#x)" }] }, "A #figure");
    expect(bodyOf(renderTypst(doc([refused])).source)).toBe("#emph[A \\#figure]\n\n");
    expect(renderTypst(doc([refused])).source).not.toContain("url(");
    expect(renderTypst(doc([drawing(figure, "x")])).assets).toEqual([]);
  });

  it("draws a squared frame as a free zone, with its grid and its greyed starter", () => {
    const starter = { viewBox: [0, 0, 96, 96] as const, items: [{ kind: "rect" as const, x: 0, y: 0, w: 10, h: 10 }] };
    const zones = bodyOf(
      renderTypst(
        doc([
          ...scopeZones("i1", [answerZone("free", { heightMm: 100, grid: { pitchMm: 4 } })]),
          ...scopeZones("i2", [answerZone("free", { heightMm: 20, grid: { pitchMm: 5 }, underlay: starter })]),
          ...scopeZones("i3", [answerZone("free", { grid: { pitchMm: Number.NaN } })]),
          ...scopeZones("i4", [answerZone("free", { underlay: { viewBox: [0, 0, 1, 1], items: [{ kind: "path", d: "x" }] } })]),
        ]),
      ).source,
    ).split("\n\n");
    expect(zones[0]).toBe('#zone("i1", "free", canvas(100mm, 4mm, none))');
    expect(zones[1]).toMatch(/^#zone\("i2", "free", canvas\(20mm, 5mm, \("<svg [^"]*.*", 20\)\)\)$/);
    expect(zones[1]).toContain("#8c8c8c");
    expect(zones[1]).not.toContain("#000000");
    expect(zones[2]).toBe('#zone("i3", "free", canvas(40mm, 4mm, none))');
    expect(zones[3]).toBe('#zone("i4", "free", canvas(40mm, 4mm, none))');
    const { source } = renderTypst(doc([]));
    expect(source).toContain("#let canvas(height, pitch, under)");
    expect(source).toContain("tiling(size: (pitch, pitch)");
    expect(source).toContain("0.25pt + luma(205)");
    expect(source).toContain('image(bytes(svg), format: "svg"');
  });

  it("words the fixed words in the document's language", () => {
    const blocks = [answerZone("name"), points(null, 3)];
    const fr = bodyOf(renderTypst(doc(blocks, "fr")).source);
    expect(fr).toContain(`names("${FR_LABELS.name}", "${FR_LABELS.firstName}")`);
    expect(fr).toContain(`Points${FR_LABELS.colon}pas encore noté \\/ 3`);
    const en = bodyOf(renderTypst(doc(blocks, "en")).source);
    expect(en).toContain(`names("${EN_LABELS.name}", "${EN_LABELS.firstName}")`);
    expect(en).toContain("Points: not graded \\/ 3");
  });

  it("returns the assets, the converted formulas and the ones printed as LaTeX", () => {
    const out = renderTypst(doc([markdown("![x](asset:img1?w=25) $x^2$ $\\nosuch$"), markdown("![y](asset:img1)")]));
    expect(out.assets).toEqual([{ id: "img1" }]);
    expect(out.formulas).toBe(1);
    expect(out.warnings).toBe(1);
    const raw = renderTypst(doc([markdown("$x^2$")]), { math: "raw" });
    expect(raw.formulas).toBe(0);
    expect(raw.warnings).toBe(1);
  });

  it("prints a hostile title and statement as text", () => {
    const { source } = renderTypst(
      doc([heading(1, '#import "@preview/x:0.1.0": *'), markdown('#import "@preview/x:0.1.0": *')]),
    );
    expect(bodyOf(source)).toBe(
      '#heading(level: 1)[\\#import \\"\\@preview\\/x:0\\.1\\.0\\": \\*]\n\n\\#import \\"\\@preview\\/x:0\\.1\\.0\\": \\*\n\n',
    );
  });
});
