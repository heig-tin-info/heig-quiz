/**
 * The page and the answer spaces of every PDF (ADR-125 §6), as Typst source
 * the renderer puts before the body. A4, margins of 20 mm (the 10 mm that
 * palier B's fiducials need stay free), fonts embedded in the Typst binary
 * only (`--ignore-system-fonts`: the same PDF on every machine) — New
 * Computer Modern, the Latin Modern look of a LaTeX paper, its maths
 * companion for formulas (Typst's default) and DejaVu Sans Mono for code —
 * the title in the header and `n / N` in the footer. No rule between
 * questions: a question's heading opens it with space above.
 *
 * A choice question's choices are a grid of boxes (`choices`), square for
 * several answers, round for one, each drawn empty or ticked by a shape of
 * its own (`square-ticked`), which the source reads as it prints. A cloze
 * dropdown's `bubbles` are round, one to pick. A heading with an aside is
 * `headed`: the aside sits outside the heading, so no bookmark holds it.
 *
 * Every answer space is a `zone(id, kind, body)`: it records
 * `(id, kind, page, x, y, w, h)` — position and size in points — as a
 * `<answer-zone>` metadata, so `typst eval 'query(<answer-zone>)…'` lists the
 * zones of the printed paper, the manifest palier B reads a scan with.
 * An image is `img(id, alt, width)`: drawn from `assets/<id>` when the API
 * could load it — `drawable`, the line it puts before the source — else its
 * alt text. Nothing here takes user text: the renderer passes it as string
 * literals.
 */

/** The fonts, both embedded in the Typst binary (`typst fonts --ignore-system-fonts`). */
export const BODY_FONT = "New Computer Modern";
export const MONO_FONT = "DejaVu Sans Mono";

/** The page margin, in millimetres: at least 20 (ADR-125 §6 reserves 10 for palier B). */
export const MARGIN_MM = 20;

export const PREAMBLE = String.raw`
#let img(id, alt, width) = if id in drawable { image("assets/" + id, width: width * 1%) } else { alt }

#let hr = line(length: 100%, stroke: 0.5pt + luma(150))

#let heading-gap = ("2": (above: 24pt, below: 10pt), "3": (above: 14pt, below: 7pt))
#show heading.where(level: 2): set block(..heading-gap.at("2"))
#show heading.where(level: 3): set block(..heading-gap.at("3"))

#let separator = block(above: 0.6em, below: 0.6em, line(length: 100%, stroke: 0.3pt + luma(200)))

#let mark(body) = box(baseline: 0.4mm, width: 3.2mm, height: 3.2mm, body)
#let tick = {
  place(line(start: (0.6mm, 1.7mm), end: (1.35mm, 2.5mm), stroke: 0.8pt))
  place(line(start: (1.35mm, 2.5mm), end: (2.7mm, 0.7mm), stroke: 0.8pt))
}
#let square-empty = mark(square(size: 3.2mm, stroke: 0.6pt))
#let square-ticked = mark({ place(square(size: 3.2mm, stroke: 0.6pt)); tick })
#let circle-empty = mark(circle(radius: 1.6mm, stroke: 0.6pt))
#let circle-ticked = mark({ place(circle(radius: 1.6mm, stroke: 0.6pt)); place(dx: 0.8mm, dy: 0.8mm, circle(radius: 0.8mm, fill: black)) })

#let choices(..cells) = block(above: 0.9em, below: 0.9em, width: 100%,
  grid(columns: (auto, auto, 1fr), column-gutter: 2mm, row-gutter: 0.8em, ..cells))

#let zone(id, kind, body) = block(breakable: false, width: 100%, layout(region => {
  let size = measure(block(width: region.width, body))
  context {
    let at = here().position()
    [#metadata((id: id, kind: kind, page: at.page, x: at.x.pt(), y: at.y.pt(), w: size.width.pt(), h: size.height.pt())) <answer-zone>]
  }
  body
}))

#let bubbles(labels) = block(above: 0.8em, below: 0.8em,
  labels.map(l => box[#circle-empty#h(1.5mm)#l]).join(h(7mm)))

#let headed(level, aside, body) = block(width: 100%, sticky: true, ..heading-gap.at(str(level), default: (:)),
  grid(columns: (1fr, auto), column-gutter: 4mm, align: bottom,
    heading(level: level, body), text(size: 0.9em, fill: luma(60), aside)))

#let rule = line(length: 100%, stroke: 0.4pt + luma(130))

#let lines(n) = block(above: 0.6em, below: 0.6em, width: 100%,
  stack(spacing: 8mm, v(0mm), ..range(n).map(_ => rule)))

#let free(height) = block(above: 0.6em, below: 0.6em, width: 100%, height: height,
  stroke: 0.5pt + luma(130), radius: 1mm)

#let field(label) = grid(columns: (auto, 1fr), column-gutter: 2mm, align: bottom,
  label, block(width: 100%, height: 7mm, stroke: (bottom: 0.5pt + luma(90))))

#let names(name, first) = block(above: 0.6em, below: 1.2em,
  grid(columns: (1fr, 1fr), column-gutter: 8mm, field(name), field(first)))
`;

/** The page setup: `title`, `lang` and the PDF metadata are string literals already. */
export function pageSetup(title: string, lang: string): string {
  return [
    `#set document(title: ${title}, author: "Quiz")`,
    `#set page(paper: "a4", margin: ${MARGIN_MM}mm,`,
    `  header: context if counter(page).get().first() > 1 { set text(size: 8pt, fill: luma(90)); emph(${title}) },`,
    `  footer: context align(center, text(size: 8pt, fill: luma(90), counter(page).display("1 / 1", both: true))))`,
    `#set text(font: "${BODY_FONT}", size: 11pt, lang: ${lang})`,
    `#set par(justify: false)`,
    `#show raw: set text(font: "${MONO_FONT}", size: 9pt)`,
    `#show raw.where(block: true): block.with(width: 100%, fill: luma(245), inset: 6pt, radius: 2pt)`,
    `#set table(stroke: 0.5pt + luma(150))`,
    `#show heading: set block(sticky: true)`,
  ].join("\n");
}
