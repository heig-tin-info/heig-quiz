import { describe, expect, it } from "vitest";

import { answerZone, choices, code, heading, list, markdown, points, scopeZones, separator, table, tests, type Block, type Document } from "../document.js";
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
        "Tests passed: 1\\/1\n\n" +
          '#table(columns: 4,\n  table.header([#strong[Test]], [#strong[Visibility]], [#strong[Result]], [#strong[Points]]),\n  [hidden\\-one], [hidden], [passed], [3],\n)',
        "Points: 1\\.5 \\/ 2",
        "Points: not graded \\/ 2",
        "#separator",
        "",
      ].join("\n\n"),
    );
  });

  it("sets a heading's aside at the line's end, outside the heading (no bookmark holds it), escaped like its text", () => {
    const { source } = renderTypst(doc([heading(2, "Question 1: #x", "2 pt"), heading(2, "Question 2")]));
    expect(bodyOf(source).split("\n\n")).toEqual([
      '#headed(2, [2 pt], [Question 1: \\#x])',
      "#heading(level: 2)[Question 2]",
      "",
    ]);
    // No rule between questions: the heading opens one, with space above.
    expect(source).toContain("#show heading.where(level: 2): set block(above: 1.8em, below: 0.8em)");
  });

  it("draws choices beside their boxes, square for several, round for one, ticked by shape", () => {
    const items = [
      { label: "A", text: "`x` #1" },
      { label: "B", text: "```c\nint y;\n```" },
    ];
    const { source } = renderTypst(doc([choices(items, false), choices(items, true, [1]), choices(items, false, [0])]));
    expect(bodyOf(source).split("\n\n")).toEqual([
      '#choices([#circle-empty], [#strong[A\\.]], [#raw("x") \\#1],\n  [#circle-empty], [#strong[B\\.]], [#raw(block: true, lang: "c", "int y;")])',
      '#choices([#square-empty], [#strong[A\\.]], [#raw("x") \\#1],\n  [#square-ticked], [#strong[B\\.]], [#raw(block: true, lang: "c", "int y;")])',
      '#choices([#circle-ticked], [#strong[A\\.]], [#raw("x") \\#1],\n  [#circle-empty], [#strong[B\\.]], [#raw(block: true, lang: "c", "int y;")])',
      "",
    ]);
  });

  it("keys a statement's choices as its item's paper zone, of kind choices", () => {
    const blocks = scopeZones("item-7", [markdown("Pick."), choices([{ label: "A", text: "one" }], false)]);
    expect(bodyOf(renderTypst(doc(blocks)).source)).toBe(
      'Pick\\.\n\n#zone("item-7", "choices", choices([#circle-empty], [#strong[A\\.]], [one]))\n\n',
    );
  });

  it("keys every answer zone for the manifest, with its shape", () => {
    const blocks = [
      answerZone("name"),
      ...scopeZones("item-1", [answerZone("bubbles", { labels: ["A", "B", 'C "x"'] })]),
      ...scopeZones("item-2", [answerZone("bubbles", { labels: ["A"] })]),
      ...scopeZones("item-3", [answerZone("lines", { part: "b0", lines: 2 }), answerZone("lines", { part: "b1" })]),
      ...scopeZones("item-4", [answerZone("free", { heightMm: 60 })]),
    ].map((b) => (b.kind === "answerZone" && b.zone === "name" ? { ...b, id: "name" } : b));
    const { source } = renderTypst(doc(blocks));
    const zones = bodyOf(source).split("\n\n");
    expect(zones).toEqual([
      '#zone("name", "name", names("Name", "First name"))',
      '#zone("item-1", "bubbles", bubbles(("A", "B", "C \\"x\\"")))',
      '#zone("item-2", "bubbles", bubbles(("A",)))',
      '#zone("item-3:b0", "lines", lines(2))',
      '#zone("item-3:b1", "lines", lines(1))',
      '#zone("item-4", "free", free(60mm))',
      "",
    ]);
    // The preamble's zone records each one under the label `query(<answer-zone>)` reads, through `typst eval`.
    expect(source).toContain("<answer-zone>");
    expect(source).toContain("#let zone(id, kind, body)");
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
