# ADR-094 — One scale for form controls: pill for one line, soft square for content

## Status

Accepted (2026-10-10, product owner Yves Chevallier, after reviewing the
go/no-go gallery of issue #552: "GO on the whole proposal").

Scope: the height, the shape and the motion of the single-line form controls of
`apps/web` and `packages/ui`: button, field, select, search box, segmented
control and chip.

Relations: amends `apps/web/DESIGN.md` ("Shape and elevation" radii rule, the
Button, Field, ToggleChip and Segmented entries); no earlier ADR owned the
radii. Complements ADR-008 (own accessible primitives) and ADR-035 (the
`packages/ui` primitives).

## Context

On the admin Users screen the four basic controls each looked different: a
field was a 10 px soft square, a button a pill, the search box a pill through
a `rounded-full` override on the field's chrome, and the segmented filter a
30 px pill beside a 34 px search box. Three size tables (`inputSize`,
`BUTTON_SIZE`, the segmented sizes) agreed only by accident, and the rule in
`DESIGN.md` ("pills for what you press, soft squares for what holds") made
fields square by construction. Hand-written heights (`h-8.5`, `h-7`, `h-8`)
and off-scale radii sat beside `inputClass`. The segmented control changed
selection with no motion.

## Decision

1. **One control scale**, a single table (`controlSize` in
   `packages/ui/src/styles.ts`) read by buttons, fields, selects, search boxes,
   segmented controls and chips: `sm` 28 px, `md` 34 px, `lg` 40 px, with a
   text size and a horizontal padding per step. `inputSize` is the field slice
   of that table, kept as an export because the question types use it.
2. **One radius for a single line**: every single-line control is a pill, the
   token `rounded-control` (`--radius-control`). The rule of `DESIGN.md`
   becomes **"pill for one line, soft square for multi-line or containing
   content"**: a textarea, a code area, a rich-text box and a formula box keep
   `rounded-field`; cards, sheets and menus keep their tokens. A segmented
   track that wraps onto several lines is a recessed panel and takes
   `rounded-card`; its options stay pills.
3. **`md` by default.** `Segmented` defaults to `md` (34 px, the height of the
   field beside it). The rule: **`sm` when every neighbour is 28 px** (table rows,
   dense popovers, editor toolbars, the drill's confidence scale, the
   header); otherwise `md`. A toolbar never mixes an `sm` control with `md`
   ones. Icon buttons (`IconButton`, 28 or
   32 px discs) are not form controls and stay outside the scale; the page
   help button is on it (34 px).
4. **An animated thumb.** The selected option of a `Segmented` is marked by a
   thumb that slides under it: its box is measured from the selected label,
   ~200 ms `ease-out-emphasized`, no transition under
   `prefers-reduced-motion`, and no slide on the first placement. The native
   radios stay inside the labels, so the keyboard, the grouping and the
   announcement are unchanged.
5. **Fewer components.** `SearchInput` is a field with a leading icon; `Select`
   shares the field chrome. `Segmented` (one choice), `ToggleChip` (several)
   and `Tabs` (navigation) stay apart: their semantics differ. A chip takes a
   `size` of the scale and defaults to `sm`.

## Consequences

- Teachers and students see rounder, aligned controls; no flow changes.
- A field is 34 px with 16 px of side padding where it was 34 px with 12 px;
  call sites no longer write a height, a radius or a horizontal padding beside
  `inputClass`.
- A field that holds content (rich text, formula, notepad, source) wears
  `areaClass`, not the pill.
- The question types and `apps/web` share the bare elements: `TextInput`,
  `Select`, `Button` and `IconButton` in `packages/ui/src/controls.tsx`;
  `apps/web`'s `Field`, `Select` (with a label) and `Button` (with a spinner)
  wrap them, so nothing is written twice. A `qt-*` package no longer writes
  `<select>`, a one-line `<input>` or a `buttonClass(...)` button by hand.
- A guard-rail test (`apps/web/src/ui/controlsGuard.test.ts`) fails on a raw
  `<select>`, on a raw one-line `<input>` (a checkbox, radio, file, range or
  hidden input is native by type), and on a `rounded-full` or a literal
  height beside `inputClass` or on a control of the scale. Its allow-list
  names each legitimate exception and its reason: a field with no chrome of
  its own (the palette's band, the cursor of a token field, a page title or a
  column title edited in place).
- Left raw on purpose, by role rather than by element: canvas hit areas and
  toolbar toggles (`aria-pressed` tools, palette tiles, the drag grip),
  list items that are drop or pick targets, a card that is itself the button
  (the expandable preview), and the code, prompt and notepad textareas, which
  are content surfaces (`areaClass`).
- `RadioRow` stays. It is a native radio list whose rows carry a title and a
  second line (a regrade version, an exam to pair, a GitHub organization):
  content, not a one-line control, so neither `Segmented` (short labels on
  one track) nor a pill fits it. Issue #552 had planned to absorb it; the
  inventory showed its uses are lists of rows.
- The dev gallery (`/dev/ui`) shows every control, measured in the browser.

## Alternatives considered

- **Keep squares for fields**: rejected by the product owner; the mixed shapes
  were the complaint.
- **Pill everywhere, textareas included**: a pill taller than two lines turns
  into a lens, which is why the wrapped track and the multi-line fields stay
  soft squares.
- **A JavaScript-only or CSS-grid thumb with fixed option widths**: measuring
  the selected label needs no per-option width and survives a wrapped second
  row and translated labels.
