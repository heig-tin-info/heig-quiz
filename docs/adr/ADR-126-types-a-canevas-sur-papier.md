# ADR-126 — Canvas question types on paper: a closed drawing model, inline SVG, a squared free frame

## Status

Accepted (2026-11-04, the product owner's decisions on the follow-up of
issue #551). Delivery progress lives in `changes/`.

Scope: the printed and exported documents of the `diagram`, `circuit`,
`logic` and `blocks` question types; the `drawing` block of the document
tree and its SVG writer; the squared form of a `free` answer zone.

Relations: amends [ADR-125](ADR-125-copies-papier-pdf-typst.md) §5 and §20
(which types print), §6 (the squared `free` zone) and [ADR-121](ADR-121-fabrique-d-exports.md) §1 (a new
block kind). Depends on ADR-125 §2 (the compile sandbox), §6 (the answer
zones), §7 (fixed words), §14 (untyped free zones), §19 (leak tests);
[ADR-046](ADR-046-type-diagramme.md) (the diagram's server entry has no
React); [ADR-123](ADR-123-type-circuit-logique.md);
[ADR-103](ADR-103-type-blocs.md); invariant 4; 05 §5.7.

## Context

ADR-125 printed the text types and left `diagram` and `circuit` out: their
figure — the canvas a student completes, and often the statement itself —
has no server-side renderer, since `packages/diagram` and
`packages/qt-circuit` draw through React only. `logic` and `blocks` came
later with the same gap. A paper exam therefore refuses every evaluation
holding one of them (`409 not_printable`), and the staff "statement with
key" prints a placeholder where the figure belongs.

Two shortcuts are ruled out: rendering the React editors on the server
(`react-dom/server` in the API breaks ADR-046's split, and the editors
measure a live DOM), and letting a type write SVG or Typst markup into the
tree (a second exit for arbitrary markup beside the escaped text of
ADR-125 §2, unchecked by any renderer).

## Decision

1. **The `drawing` block** (amends ADR-121 §1):
   `{ kind: "drawing"; drawing: Drawing; alt: string; widthMm?: number;
   maxHeightMm?: number }`. A `Drawing` is a closed model in
   `packages/docexport` (`src/drawing.ts`): `{ viewBox: [x, y, w, h];
   items: DrawingItem[] }`, where an item is a `path`, `rect`, `circle`,
   `ellipse`, `line`, `text`, or a group `g` with an optional affine
   `matrix` transform. Shapes are painted with a closed set of paints —
   `none`, `ink`, `grey`, `faint`, `paper` — a stroke width, a dash array
   and an opacity; a text has `x`, `y`, `text`, `anchor`
   (`start`/`middle`/`end`), `baseline` (`alphabetic`/`middle`), `size`,
   `weight` (`normal`/`bold`) and `italic`. A block never holds markup of a
   target format: each canvas type writes a `Drawing` from its model through
   a **pure serializer of its own**, with no React and no DOM; the
   diagram's geometry moves from `packages/diagram/src/editor/shapes.tsx`
   into a pure paint module both the editor and the serializer use.

2. **One SVG writer, `toSvg`**, pure, in `packages/docexport`. Its output
   is built element by element from the model, under these rules:
   - colours are literals (`#000000`, `#8c8c8c`, `#d2d2d2`, `#ffffff`),
     never a CSS variable or a class;
   - every text carries `font-family="DejaVu Sans Mono"`, the only
     monospace font the Typst binary embeds; its four faces (regular, bold,
     oblique, bold oblique) are embedded, so `weight` and `italic` hold under
     `--ignore-system-fonts` (verified on Typst 0.15.1);
   - a text's content is XML-escaped (`& < > " '` as character references,
     characters XML 1.0 refuses dropped);
   - no `class`, `style`, `href`, `image`, `use`, `foreignObject`, script or
     `url(…)`: the writer has no way to emit them;
   - a path's data must match `^[MLHVCSQTAZmlhvcsqtaz0-9 .,eE+-]*$`;
   - every number must be finite and within ±10⁶; widths, sizes and
     opacities are clamped into range;
   - caps: 5,000 items, groups 8 deep, 500 characters per text, 20,000 per
     path, 500,000 for the whole SVG.

   A drawing that breaks a rule is refused as a whole, and the document
   prints the block's `alt` text instead. The PDF embeds the SVG inline,
   `image(bytes(<string literal>), format: "svg")`: no asset file, nothing
   new in the compile root, no change to the sandbox of ADR-125 §2.

3. **The squared frame.** The `free` answer zone gains
   `grid?: { pitchMm: number }` and `underlay?: Drawing`. With either, the
   Typst renderer draws a frame of the zone's height whose light-grey grid
   is native Typst — a `tiling` of 0.25 pt lines at `luma(205)`, 4 mm apart
   by default (2 to 20 mm) — still wrapped by `zone()`. The zone **stays
   `free`**: its metadata kind, palier B's manifest and ADR-125 §14 (an
   untyped free zone is proposed at 0, `paper_free_zone`, graded by hand)
   apply unchanged. The Markdown hand-out previews it as a plain frame.

4. **The starter.** A diagram's starter is the frame's `underlay`, drawn
   at the frame's top left in grey: `toSvg` with `greyed` maps `ink` to
   `grey`, whatever the type wrote. An underlay `toSvg` refuses is left out;
   the frame stays.

5. **Scale.** A drawing is printed at `widthMm`, else one drawing unit per
   CSS pixel (1 px ≈ 0.26 mm), never wider than the 170 mm text column,
   and narrowed to keep `maxHeightMm`. A circuit or logic box of 40 × 25
   cells prints at 4 mm per cell, 160 × 100 mm; a diagram at 1 px ≈
   0.26 mm, shrunk to the column.

6. **The frame's height never comes from the reference.** A hand-out's
   frame is sized from the student view (the starter, the box, a type's
   default), never from the reference design: its size would tell the
   student how large the answer is.

7. **Fixed words of a figure** follow the reader's language (ADR-125 §7):
   `Labels` carries its own `lang`, and every hook that writes words of its
   own — a pseudo-code keyword, a figure's caption — receives the reader's
   `Labels`; `answerZone` gains that parameter when the first type needs it.

8. **Which types print, and what** (amends ADR-125 §5 and §20):
   - `diagram`, `circuit`, `logic`: `answerZone` returns a squared `free`
     frame; `statementDoc` prints the figure the student is given (a
     circuit's or a logic box's fixed parts, a diagram's starter); the
     documents that show the key (`solutionDoc`) print the reference design
     as a `drawing`.
   - `blocks`: the answer zone is `lines`, for pseudo-code written by hand;
     the statement prints the visible warehouse maps as drawings, the
     battery, the toolbox and the starter program as pseudo-code; the key
     prints the reference program as pseudo-code. A hidden warehouse never
     reaches a student document (#998). A blocks answer is typed by the
     teacher through the paper entry page like any typed answer; ADR-125
     §14 does not apply to it.
   - The student's own answer drawn in their copy (`studentAnswerDoc`) is a
     later, optional step.

9. **Leak tests** (ADR-125 §19, 05 §5.7). Each printable canvas type is
   tested with a full configuration: the tree, the Typst source and the
   Markdown are searched for the answer-key values, and the PDF text too —
   **SVG text stays text in the PDF**: `pdftotext` extracts it (verified on
   Typst 0.15.1), so a key value written into a figure is caught in all
   four forms. A key drawn only as shapes, with no text, is caught in the
   tree and the source.

10. **Grading of a paper attempt is unchanged.** No machine reading of a
    drawing; a canvas item is graded by hand as any free zone.

11. **Sequence**, each step its own pull request: (1) this record and the
    `docexport` infrastructure; (2) `circuit` and `logic`; (3) `diagram`,
    with its pure paint module; (4) `blocks`; (5) optionally, the student's
    answer drawn in copies.

## Consequences

- An exam holding a canvas question can be printed; its statement and key
  documents show the figures instead of a placeholder.
- One more writer of untrusted output, kept small: the model is closed and
  `toSvg` is the only place that turns it into SVG, with refusals tested.
- Each canvas type owns a second rendering of its model, beside the
  editor's; a pure paint module shared by both limits the drift for the
  diagram, the largest.
- The figure's fonts are monospace only, the one family the binary embeds
  for every face; a figure's typography may differ from the screen's.
- A large drawing makes a large Typst source; the caps bound it.

## Alternatives considered

- **`react-dom/server` rendering the editors' SVG in the API**: React in
  the API against ADR-046's split, and editors that measure a live DOM.
- **A type writing SVG or Typst markup into a block**: an unchecked second
  path for markup beside ADR-125 §2's escaping; the closed model keeps one.
- **SVG as an asset file in the compile root**: a file per figure for no
  gain; the inline string literal needs no change to the sandbox.
- **The grid as an SVG pattern**: a large drawing per frame where Typst's
  native `tiling` is one line of source.
- **A new zone kind (`canvas`)**: palier B's manifest and ADR-125 §14 would
  need a case for what is, on paper, a free frame.
- **Blockly's own rendering for `blocks`**: block shapes need the Blockly
  runtime and a DOM; pseudo-code reads well on paper and is written by hand.
- **Sizing the frame from the reference design**: a leak of the answer's
  size (point 6).
