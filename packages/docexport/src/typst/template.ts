/**
 * The page and the answer spaces of every PDF (ADR-125 §6), as Typst source
 * the renderer puts before the body. A4, margins of 20 mm (the 10 mm that
 * palier B's fiducials need stay free), the two fonts embedded in the Typst
 * binary only (`--ignore-system-fonts`: the same PDF on every machine),
 * the title in the header and `n / N` in the footer.
 *
 * Every answer space is a `zone(id, kind, body)`: it records
 * `(id, kind, page, x, y, w, h)` — position and size in points — as a
 * `<answer-zone>` metadata, so `typst eval 'query(<answer-zone>)…'` lists the
 * zones of the printed paper, the manifest palier B reads a scan with.
 * An image is `img(id, alt, width)`: drawn from `assets/<id>` when the API
 * could load it — `drawable`, the line it puts before the source — else its
 * alt text. A figure is `figsvg(svg, alt, width)`: the SVG the renderer
 * wrote from a closed drawing (ADR-126), inline, never a file. A free frame
 * is `free(height, pattern:, pitch:, under:)`: plain, or ruled by a native
 * `tiling` — a square grid or horizontal lines (ADR-126 §3) — with an
 * optional starter `(svg, width)` drawn under it, clipped by the frame.
 * Nothing here takes user text: the renderer passes it as string literals.
 */
import { DRAWING_FONT } from "../drawing.js";

/** The fonts, both embedded in the Typst binary; a drawing's text uses the mono one. */
export const BODY_FONT = "Libertinus Serif";
export const MONO_FONT = DRAWING_FONT;

/** The page margin, in millimetres: at least 20 (ADR-125 §6 reserves 10 for palier B). */
export const MARGIN_MM = 20;

/** An A4 page, in millimetres. */
export const PAGE_MM = { width: 210, height: 297 } as const;

export const PREAMBLE = String.raw`
#let img(id, alt, width) = if id in drawable { image("assets/" + id, width: width * 1%) } else { alt }

#let figsvg(svg, alt, width) = block(above: 0.8em, below: 0.8em, breakable: false, width: 100%,
  align(center, image(bytes(svg), format: "svg", width: width * 1mm, alt: alt)))

#let hr = line(length: 100%, stroke: 0.5pt + luma(150))

#let zone(id, kind, body) = block(breakable: false, width: 100%, layout(region => {
  let size = measure(block(width: region.width, body))
  context {
    let at = here().position()
    [#metadata((id: id, kind: kind, page: at.page, x: at.x.pt(), y: at.y.pt(), w: size.width.pt(), h: size.height.pt())) <answer-zone>]
  }
  body
}))

#let bubble(multiple) = if multiple {
  box(baseline: 0.6mm, square(size: 3.6mm, stroke: 0.6pt))
} else {
  box(baseline: 0.6mm, circle(radius: 1.8mm, stroke: 0.6pt))
}

#let bubbles(labels, multiple) = block(above: 0.8em, below: 0.8em,
  labels.map(l => box[#bubble(multiple)#h(1.5mm)#l]).join(h(7mm)))

#let rule = line(length: 100%, stroke: 0.4pt + luma(130))

#let lines(n) = block(above: 0.6em, below: 0.6em, width: 100%,
  stack(spacing: 8mm, v(0mm), ..range(n).map(_ => rule)))

#let ruling(pattern, pitch) = tiling(size: (pitch, pitch), {
  place(line(start: (0pt, 0pt), end: (pitch, 0pt), stroke: 0.25pt + luma(205)))
  if pattern == "grid" { place(line(start: (0pt, 0pt), end: (0pt, pitch), stroke: 0.25pt + luma(205))) }
})

#let free(height, pattern: none, pitch: 4mm, under: none) = block(above: 0.6em, below: 0.6em, width: 100%,
  height: height, stroke: 0.5pt + luma(130), radius: 1mm, clip: true,
  fill: if pattern == none { none } else { ruling(pattern, pitch) },
  if under != none { place(top + left, image(bytes(under.at(0)), format: "svg", width: under.at(1) * 1mm)) })

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
