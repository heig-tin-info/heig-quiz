# Design system: Quiz (web)

Character: calm and precise, a tool a teacher trusts between two lectures and
a student opens the night before a deadline. Nothing shouts; the one red
element on a screen is the thing to click.

Every value below carries its reason. A value outside this file is either an
extension (add it here, with its why, in the same change) or a mistake.

## Color

Warm neutrals: the product sits next to GitHub and code editors, which are
cool and gray. A paper-warm canvas separates it from them and softens the
HEIG red, which turns harsh on a pure white or a cool gray.

Semantic tokens only in components (`bg-surface`, `text-fg-muted`, …); the
raw values live in `src/style.css` and swap in dark mode without any
`dark:` variant in the markup.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `#f6f5f2` | `#131211` | page background |
| `surface` | `#ffffff` | `#1b1a18` | cards, sheets, inputs |
| `surface-2` | `#f3f1ed` | `#232220` | recessed panels, hover rows |
| `surface-3` | `#eae7e1` | `#2c2a27` | segmented tracks, skeletons |
| `line` | `#e7e4de` | `#2a2825` | hairlines (the separation language) |
| `line-strong` | `#d3cfc7` | `#3a3733` | input borders, focused hairlines |
| `fg` | `#1a1917` | `#ecebe7` | text, and the timeline "now" marker (red there would read as one more bar) |
| `fg-muted` | `#67635b` | `#a39e94` | secondary text, ≥ 4.5:1 on surface and surface-2 |
| `fg-faint` | `#726d64` | `#8d887f` | captions, disabled, icons at rest; ≥ 4.5:1 on canvas and surface |
| `accent` | `#b41f24` | `#e85f64` | HEIG red (brand constraint): primary action, focus ring |
| `accent-hover` | `#9a1b1f` | `#f0787c` | |
| `accent-soft` | `#fbebeb` | `rgb(232 95 100 / 0.10)` | selected nav item, accent chips |
| `on-fill` | `#ffffff` | `#131211` | ink laid on a saturated fill (accent, danger, success) |
| `success` / `success-soft` | `#1f7a4d` / `#e7f4ec` | `#4cc38a` / `rgb(76 195 138 / 0.14)` | semantic only |
| `warning` / `warning-soft` | `#a35810` / `#fdf1e2` | `#f0a04b` / `rgb(240 160 75 / 0.14)` | semantic only |
| `danger` / `danger-soft` | `#c2242a` / `#fbe9e9` | `#f26d72` / `rgb(242 109 114 / 0.14)` | destructive actions, failures |
| `info` / `info-soft` | `#1268a0` / `#e8f2f9` | `#58a9e0` / `rgb(88 169 224 / 0.14)` | "a set of possibilities", the progress half of a cell state, and a `SegmentedBar` share that is no verdict (the pool's choices picked, ADR-043) |
| `info-mid` / `on-info-mid` | `#b8d7f0` / `#0d5286` | `rgb(88 169 224 / 0.35)` / `#a6d3f3` | the ANSWERED cell of the live grid only |

A grade (`<Grade>`, `apps/web/src/Grade.tsx`) is written in `danger` below
4.0 and in `warning` from 4.0 to 4.4, in the ink from 4.5; its ECTS label
("Satisfactory (D)") is on hover and in the text for a screen reader. The
histogram's bars follow the same bands. Teacher and student see the same
colours.

Rule: strip the accent and every screen must still read. Hierarchy comes
from size, weight and position, never from red.

`info` is the calm blue of the logo's "I" bubble (`#0086d1`) taken down to
reading weight — not a saturated link blue, which would read as "click me" in
a page where the one thing to click is red. Its first job is one
distinction: a `{{…}}` chip in the cloze editor holding ONE answer wears the
accent, and one standing for a SET of possibilities (several answers, or a
dropdown) wears this. A teacher scanning a paragraph of holes tells the two
apart without reading a word of them.

Its second job is the PROGRESS half of a `VerdictCell` — `info-mid` for a
question that holds an answer (`info-soft` was a tint that vanished on a
projector and against the dark surface), the `info` fill for one they have validated
(`forward_only`, a crossed checkpoint) — and it is the same job seen from another side: green, amber and red on
that grid mean "right, partly, wrong", so progress cannot borrow any of them,
and a blue that is not a link colour is exactly what is left. The two
strengths are the progression itself; a column darkening downward is a class
moving through the quiz, legible at squinting distance and on a projector.
Nothing on a `bg-info` fill may be written in `fg`: the ink is `on-fill`,
like every other saturated fill.

`on-fill` exists because one red cannot do both jobs in dark mode: a red
light enough to read as text on `#1b1a18` (≥ 4.5:1) is too light to carry
white text (≥ 4.5:1 would need a luminance it cannot have at the same time).
So the fill keeps the bright dark-mode red and the ink turns near-black.
Components never write `text-white` on `bg-accent`, `bg-danger` or
`bg-success`: they write `text-on-fill`, which swaps by itself.

### Measured contrast (WCAG 2.1 relative luminance)

Every pair the design promises, computed on the values above (translucent
`-soft` backgrounds composited over `surface`). Text pairs are held to 4.5:1,
non-text ones (focus ring) to 3:1. `fg-faint` used to be held to 3:1 as a
decorative tone — but a caption is read, not glanced at: "Choose one answer.",
"14 minutes left" and a course code all live in it, and a reader who cannot
make them out has lost the sentence, not an ornament. So it is held to 4.5:1
on `canvas` and on `surface`, in both themes, and stays a clear step quieter
than `fg-muted`. A caption that carries information a screen cannot repeat
belongs in `fg-muted` anyway; `fg-faint` is for the ones that only support it.

| Pair | Light before | Light after | Dark before | Dark after |
| --- | --- | --- | --- | --- |
| `fg-muted` on `surface` | 5.98 | 5.98 | 6.52 | 6.52 |
| `fg-muted` on `surface-2` | 5.30 | 5.30 | 5.96 | 5.96 |
| `fg-faint` on `surface` | 3.43 ✗ | **5.14** | 3.19 ✗ | **4.94** |
| `fg-faint` on `canvas` | 3.15 ✗ | **4.71** | 3.44 ✗ | **5.31** |
| `success` on `success-soft` | 4.70 | 4.70 | 6.10 | 6.10 |
| `warning` on `warning-soft` | 4.48 ✗ | **4.76** | 6.27 | 6.27 |
| `danger` on `danger-soft` | 5.01 | 5.01 | 4.88 | 4.88 |
| `info` on `info-soft` | — | **5.27** | — | **5.39** |
| `info` on `surface` | — | **5.98** | — | **6.76** |
| `on-info-mid` on `info-mid` | — | **5.46** | — | **5.70** |
| `accent` on `accent-soft` | 5.75 | 5.75 | 3.75 ✗ | **4.58** |
| `accent` on `surface` | 6.64 | 6.64 | 4.31 ✗ | **5.18** |
| `on-fill` on `accent` | 6.64 | 6.64 | 4.03 ✗ (white) | **5.57** |
| `on-fill` on `accent-hover` | 8.23 | 8.23 | 3.39 ✗ (white) | **6.85** |
| `on-fill` on `danger` | 5.87 | 5.87 | 2.91 ✗ (white) | **6.42** |
| focus ring on `surface` / `canvas` | 6.64 / 6.09 | 6.64 / 6.09 | 4.31 / 4.64 | 5.18 / 5.57 |

Two pairs stay below their target, on purpose:

- `line-strong` on `surface` (1.55 light, 1.47 dark). Field borders and the
  switch track are hairlines; taking them to 3:1 would turn the whole
  interface into a wireframe and contradict the separation language above.
  The controls stay identifiable by their fill, their label and a focus ring
  at 5:1 or better.
- the white switch knob on the `success` track in dark mode (2.22). The state
  is carried by the track colour and the knob position, not by the knob edge.

## Typography

- Family: **Manrope** (variable, self-hosted through `@fontsource-variable`).
  Geometric with distinctive `a`, `g` and `t`: it has a voice at 28 px and
  stays quiet and legible at 13 px. One family; the contrast lives in the
  size jump and the weight jump, not in a second face.
- Mono: **JetBrains Mono** for SHAs, repository names, milestone keys and
  anything a student will copy.
- Scale (px): 12 caption · 13 dense UI (tables, chips) · 14 body · 16 section
  title · 20 sheet title · 28 page title. Page title / body = 2×, and the
  title is 700 with `-0.02em` tracking; body is 400, labels 500.
- Numbers in tables and countdowns are tabular (`tabular-nums`).

## Spacing

- Base 4 px; scale 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
- Rhythm: tight inside a group (4–8), comfortable inside a card (16–20),
  generous between sections (32) and between the page header and its body
  (24). A screen that is all 16 px gaps has made no decision.
- Content column: 1120 px max, 32 px side gutter from `sm` (16 on phones), written
  once as `PAGE_COLUMN` (`ui/page.tsx`); the pool widens past it by the
  width of its docked question pane (below).
- A navigation list is capped, not scrolled: the sidebar shows twelve
  classrooms and a "Show all (N)" row, always including the one being read.
  Thirty names in a column is a wall, and it pushes the account row off.
- The frame has three widths (`Shell.tsx`): the 240 px sidebar from `xl`
  (1280); the same sidebar FOLDED to a 56 px column of icons from `lg`
  (1024) to `xl`, where 240 px of names took a fifth of a 13" laptop;
  the top bar and its drawer under `lg`. Folded, the column keeps the
  top-level rows only (36 px squares, 4 px apart, the lit one the same
  `accent-soft` chip), the Q bubble for the wordmark, and at the bottom the
  view switch and the avatar, stacked. Each icon names itself in a `Tip` at
  its RIGHT (`side="right"`) and to a screen reader; the avatar's tip is the
  person's name. The course and pool trees, the classroom list and the
  shortcut strip are names, not icons, and wait for the full sidebar: the
  course list and Ctrl+K reach the same places. A folded row never toggles
  a tree it does not show; it only navigates.

## Shape and elevation

- Radii: controls (buttons, chips, segmented, avatars) are **pills**;
  fields 10 px; cards 12 px; sheets and dialogs 16 px; menus 12 px.
  Pills on everything you press, soft squares on everything that holds —
  save the keys of the calculator's keypad, soft squares in a grid (below).
  Each of those was one step larger (12 / 16 / 20 / 14) and the previous
  radii read as soft and toy-like next to dense tables: the pool table, the
  live grid and the grading list are the screens this product is for, and a
  16 px corner around a 13 px row makes the card louder than its contents.
  The pills are untouched — they mark what you press, and that distinction is
  the point of the scale.
  In the markup the radii are the tokens `rounded-field`, `rounded-card`,
  `rounded-sheet`, `rounded-menu` and `rounded-key` (`style.css`), never a
  bracketed pixel value that happens to equal one. Two values stand outside
  the scale, on purpose:
  - **28 px, the pool's floating bulk bar.** It is a pill on one line — the
    browser clamps a radius to half the height, so 28 px on a 44 px bar IS
    the pill — but on a phone its five actions wrap to two lines, and
    `rounded-full` would turn that taller bar into a lens. 28 px keeps it a
    pill while it fits and a rounded rectangle when it does not.
  - **14 px, the poll projection's QR tile.** The tile belongs to the
    projection's own scale (below): it is sized with `clamp()` to the wall,
    88 to 132 px, like every other size on that screen, and its corner is
    one step above the card's to stay in proportion with a tile larger than
    anything the 12–28 px scale was drawn for. It is the only 14 px corner
    in the product, and it exists only on the projector.
- Separation language: **1 px hairlines** (`line`), one surface level below
  for recessed panels (`surface-2`). No shadows on anything in the page
  flow. Shadows exist only on floating layers (menu, popover, sheet, dialog,
  toast), because those genuinely sit above the page.
- Focus: 2 px accent ring at 2 px offset, on every interactive element. It is
  declared once in `style.css` on `:focus-visible`; no component restyles it,
  except the mode banner (below), whose dark fill would swallow a red ring,
  and the cells of the pool's tag heat (below), whose box would clip it.

## Long-form reading (the journal)

The journal (ADR-049) is the one surface of the product that is a
*document* rather than a dashboard or a question, and it needs values the
rest of the app does not. They live in one modifier, `.md-body.md-doc`, on
top of the `.md-body` every rendered markdown wears (`style.css`); a
question's prose never carries it, so the question scenes do not move.

- **Measure capped at 72 characters** (`max-width: 72ch`), not the 1120 px
  content column. That column is right for a table and too wide for prose:
  past roughly 75 characters the eye loses the line it is returning to.
  The cap is on what is read — paragraphs, lists, quotes, headings — not on
  a code block or a table, which are scanned and keep the column's width
  (capped, they would only scroll sooner).
- **Leading 1.75** on 14 px body text, against the 1.6 of a question. A
  page is read for minutes, not scanned for seconds. Code blocks keep 1.6:
  code is scanned, not read.
- **Headings enter one step higher**: `h1` at the page-title step (28 px /
  700 / `-0.02em`), because the page *is* the document and owns its title;
  `h2` 20 (the sheet-title step), `h3` 16 (the section-title step), `h4`
  and below 14 at 600. The same scale as everywhere else — in a question,
  `h1` enters at 20 because it sits inside a card. Headings take 32 px above
  and 12 below (a heading belongs to what follows it), blocks 16 between
  them instead of 12, a rule 32 above and below.
- **Everything else is `.md-body` unchanged**: the same tokens in both
  themes (no colour of its own, so dark mode follows by itself), the same
  radii — a code block and an image at `rounded-field` (10 px), inline code
  at 5 px — not classroom's larger 12/16 scale, which this product left
  (Shape and elevation). Syntax colour in a code block (`.tok-kw` in
  accent, `.tok-str` in success) is semantic and does not count as the
  screen's one accent use.

- **The reader around it** (`src/journal/JournalReader.tsx`): the
  navigation is a **strip of pages** (`JournalStrip.tsx`), a row of its
  own under the classroom's tabs and above the staff bar, at every width,
  not sticky. It is a `<nav>` of real links with `aria-current="page"`,
  not a tablist, so it does not reuse `Tabs` (buttons, roving tabindex):
  a middle click opens a page in a tab, a plain click is routed in the app
  through `navigate` (and so through the editor's leave guard). What it
  shares with `Tabs` is `useScrollFade` and `revealInStrip`: a journal has
  one folder per week (about 14 entries), so the strip scrolls sideways
  under the 36 px fade and the current entry is scrolled into sight on
  load and on navigation. It is visually subordinate to the classroom's
  tabs and their 2 px ink underline: 13 px, 28 px tall entries, 4 px
  apart, no underline; the entry being read — the page, or the top-level
  folder that holds it — is an `accent-soft` chip, the ONE accent of the
  reader (a student has no primary action there). A label is cut at
  12 rem (full title in `title`). The home is the first entry, only when
  the journal has one. A folder with a landing page is a split control:
  its label links to the landing page, a chevron opens a `Menu` of its
  pages (the landing page first, deeper levels indented 12 px a level, a
  deeper folder without a landing page as a heading); a folder without
  one is a single entry that opens the menu and never navigates
  (F-JRN-06). A page hidden from students (staff payload only) carries an
  eye on its own entry or menu item, never summed up on a folder's entry.
  The page is a centred 48 rem column (the prose capped at 72 ch inside
  it): no navigation column eats the width any more. From `xl` (1280) a
  13 rem table of contents stands at its right, 32 px away, sticking to
  the top of the window; below `xl`, phone included, it folds into a
  small "On this page" disclosure above the page. The page is a sheet
  (`surface`, hairline, card radius) on the canvas; the strip and the
  table of contents are bare. The reader is a tab of the classroom page
  (both roles), under its header and tabs, with no breadcrumb of its own (the
  student's compact header above the tabs wears the page's trail);
  the staff get one bar under the strip, right-aligned, drawn by the
  journal's mode (ADR-057). In Quiz mode: the Pages menu (`Actions`
  forced to a menu: add a page, History, Deleted pages, then delete this
  page, `danger`, under a hairline), then **Edit**, the bar's one
  `primary`. In GitHub mode, read-only: the sync state in 12 px
  `fg-faint` (red on a failure), Refresh, a `secondary` `sm` button
  reading "Refreshing…" until the copy's state moves, then **Edit on
  GitHub**, the bar's one `primary`: a link to github.com's editor of the
  page's file, in a new tab, with the `ExternalLink` icon.
  History and Deleted pages are sheets: the history lists the page's
  saves (date at 13 px tabular, author 12 px muted, the newest badged
  "Current"; the one on view an `accent-soft` row), the revision on view
  under them on `surface-2`, rendered by the server's renderer or as its
  markdown (a `sm` segmented), and "Restore this version" is the sheet's
  one `primary`, confirmed.

- **The editor** (`src/journal/editor/`, Quiz mode only) takes the
  page's place on the same route; the strip stays, the table of contents
  goes (it would go stale as the teacher types). The staff bar becomes the
  editor's: "Unsaved changes" or "No changes" in 12 px `fg-faint` on the
  left, Cancel (`secondary`) and Save (`primary`, off while nothing
  differs) on the right. The page's sheet holds the front matter as one
  row of fields (title, date, visible from, draft; stacked on a phone), a
  hairline, then the platform's standard rich field (the one question
  statements use, its source view included), whose surface wears
  `.md-doc` too (`longForm`): the teacher writes in the type students
  read. A save refused because someone saved meanwhile is the one red
  block, above the sheet: the draft stays, "Copy my text" (`secondary`)
  and "Reload the page…" (`danger`, confirmed). The source view adds the
  server's preview under the textarea, on demand (`secondary`), on
  `surface-2`.

The rendered HTML comes from the server (`packages/docrender`, D15: the
journal escapes raw HTML), so, like `.md-body` itself, these are tag
selectors in `style.css` rather than utility classes — there is no React
markup to hang a class on.

## Keyboard and focus

A floating layer is not finished until it behaves. `useLayer` in `ui/layers.tsx`
holds the contract for `Modal`, `Sheet`, the confirm dialog, the mobile
drawer and the help drawer:

- open: focus moves into the panel (an `autoFocus` inside wins, otherwise the
  first focusable element, otherwise the panel itself, which carries
  `tabIndex={-1}`);
- while open: Tab and Shift+Tab cycle inside the panel, and only the topmost
  layer answers Escape, so the help drawer opened from a dialog closes alone;
- close: focus goes back to the element that opened the layer;
- naming: `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing
  at the panel's own title.
- closing on the backdrop depends on what the layer holds. A **form layer**
  (`Modal`, `Sheet`, the confirm dialog) never closes on a backdrop click: a
  stray click must not discard what the user typed, so Escape and the X are
  the two ways out. A **navigation layer** (the mobile drawer, the help
  drawer) holds nothing the user wrote, and closes on the backdrop as well:
  there, insisting on the X is friction for nothing.
- a form layer is portalled but still inside the React tree that rendered it,
  so its root stops click propagation: a click in a dialog opened from a
  table row must not reach that row's `onClick`.
- the **expand layer** (`ExpandPanel`, `ui/expand.tsx`) is where a canvas
  of the `diagram` or `circuit` type grows to (ADR-046, addenda): the page
  covered with a 16 px margin, a thin bar — what the layer holds on the
  left, a status on the right, ONE primary button that closes it — and no
  backdrop close. It leaves Escape to the canvas first (`useLayer(…,
  { escape: false })`): a canvas consumes the key (`preventDefault`) only
  when it cancelled something, and the layer closes on a key left alone.
  Two bars, one panel: the attempt's (clock, save state, "Back to the
  questions", Alt+←/→) and the teacher's (title, save state, "Close").

`Menu` follows the WAI-ARIA menu button pattern: `aria-haspopup="menu"` and
`aria-expanded` on the trigger (cloned onto a custom one), Enter / Space /
ArrowDown open on the first item and ArrowUp on the last, arrows wrap,
Home/End jump, Escape and Tab close and hand the focus back to the trigger.
Items are `role="menuitem"` with `tabIndex={-1}`.

`Tabs` uses a roving tabindex: one tab in the Tab order, ArrowLeft/ArrowRight
move and select with wrap, Home/End jump. A `value` matching no item still
leaves the first tab reachable, so a hand-edited URL cannot take the whole
strip out of the Tab order.

The index arithmetic behind those keys is written once, in `ui/menu.tsx`:
`listboxIndex` for a vertical list (the menu, the palette, and the tag,
teacher and filter comboboxes through `useCombobox` — arrows wrap, and
Home/End only where the list owns them, since in a text field they move the
caret) and `rovingIndex` for a horizontal roving strip (`Tabs`,
`ProgressSegments`). They return the next index or null and nothing else:
`preventDefault`, opening the list and moving the focus stay with the
caller (a component, or `useCombobox` for the three comboboxes), because
that is where the components legitimately differ. They exist because five
lists and two strips each wrote that arithmetic out by hand.

An element made clickable without being a button (a card, a table row) takes
`pressable()` from `ui/layers.tsx`: `tabIndex={0}` plus Enter and Space, with Space
prevented from scrolling the page. A row keeps `role="row"`; announcing it as
a button would cost the reader the table around it. The pool's rows and cards
are the exception, because there a click LOOKS and Enter EDITS: they answer
their own keys (`useQuestionBrowse`, below), P is the keyboard's click and
Space stars the question.

Ctrl+K (⌘+K on Apple keyboards) opens and closes the command palette, from
anywhere, including from inside a field: that is the convention wherever the
shortcut exists, and the default is prevented because Firefox otherwise takes
it to its own search bar. Alt or Shift held, the event is the browser's.
Inside the palette the arrows move the selection, Home and End jump, Enter
runs and Escape closes, all without the focus ever leaving the search input.

`Tip` never takes the focus (portal, `pointer-events-none`, `aria-hidden`)
and Escape dismisses it. A `Tip` inside a popup trigger whose panel is open
(a `Menu` or `Popover` trigger) stays shut, and a bubble too tall for the room
above its anchor (a picture, `media`) opens below instead.

A label cut by an ellipsis carries a `Tip` with the whole of it — the
sidebar's classroom names first, which outgrow 240 px routinely. The `Tip`
wraps the ROW, so the name reads the same on hover and on Tab, and it is
armed only when the label is REALLY cut (`useTruncated`, which measures
`scrollWidth` against `clientWidth`): a bubble repeating a label the eye
already reads is noise on every row of the list.

A sidebar row carries ONE label (#153). A classroom row shows its name and
nothing beside it: a second label (the course code) cut the name on almost
every row at 240 px and did not even tell two classrooms of one course apart.
The course (code · name) is what that row's `Tip` always says, preceded by the
whole classroom name when the ellipsis cut it. The Classrooms section sits
under a `border-t border-line` hairline, like the shortcut strip: it is apart
from the navigation, and it looks apart.

"Courses" and "Question pools" disclose a tree under their row, and both
behave alike (`useNavCycle`, #154): the one being read, or all of them,
remembered per browser. Like every sidebar row, a click navigates to the
section's list page, from wherever the reader is; only a click on that list
page, where there is nowhere left to go, toggles the tree. In a tree the current
row is marked by weight (`font-semibold text-fg`), never by `accent-soft`:
the one accent chip of the column belongs to the current page's row, and a
classroom shown both in the course tree and in the flat section would
otherwise read as two selections.

Toasts sit in one `aria-live="polite"` region, each one a `role="status"`
with a keyboard-reachable dismiss button.

## Motion

- 120 ms for micro feedback (hover, press), 200 ms for panels and menus,
  260 ms for sheets. Easing `cubic-bezier(0.2, 0, 0, 1)`. Presses scale to
  0.97. Honors `prefers-reduced-motion`.

## Coach marks

The speech bubbles that introduce a screen to a newcomer (`src/coach/`). They
are the one surface allowed to break the motion and finish rules above,
because they are not the page: they talk ABOUT it, and must read as a voice
over it, not as one more card in it.

- What: a TOUR per screen (two to five bubbles, in order, frame first) played
  the first time the screen is reached, and one NUDGE per screen offered to
  someone who looks stuck (pointer wandering, controls brushed past, the page
  scrolled back and forth, nothing clicked for 20 s). The text and the
  targets are data (`coach/catalog.ts`); a target is `[data-coach="…"]` on
  the element, or a tab's id. A step whose target is missing is skipped and
  stays unread, so it shows the day the control does.
- Memory: what was read is on the ACCOUNT (`Me.coach.seen`), not in the
  browser, so a teacher is not taught the same screen on a second device.
  Settings has the switch and "Show them again"; every lone bubble has "No
  more tips", which turns them all off.
- Never: on a full-screen view (an exam, a projection, a join page), over a
  dialog (the layer hides while one is open), or blocking — no backdrop, no
  focus taken. Escape skips; clicking the control pointed at counts as read.
- Shape: 320 px, 20 px radius, a 2 px rim in a slowly turning conic gradient
  from `accent` to `info` (the colours of the logo's bubbles), a tail filled
  with the same gradient, the overlay shadow plus a faint accent halo. The
  target wears a 2 px accent ring 6 px out, with two ripples. `Z.coach` sits
  over the page and its sticky bars, under every dialog.
- Bottom docks: a bar docked on the window's bottom edge and marked
  `data-bottom-dock` (the student's bottom bar, the launch step's phone dock)
  takes its height out of the window the coach places in (`visibleBottom`).
  The bubble stays above it, the target is scrolled to the middle of what is
  left, the ring is clipped where the bar starts, and a target wholly behind
  the bar hides the bubble until it is scrolled back: a bubble never covers
  the navigation a thumb is reaching for, nor points into it.
- Motion: pops out of its own tail (scale 0.35 → 1.06 → 1, a degree of
  rotation, 620 ms), floats (4 px, 3.2 s), glides to the next target with an
  overshooting ease (500 ms) while its content cross-fades, and ends a walk
  with a burst of sparks. Under `prefers-reduced-motion` all of it is off:
  the bubble simply appears where it belongs.

## Browser state

The few things a screen reads from the browser rather than from the server
live in `ui/state.ts`, each written once.

- `usePersistentChoice(key, values, fallback)`: a choice that is a reader's
  HABIT and not a state of the data — table or cards, the grouping of the
  pool, the cycle of the pool and course trees (`useNavCycle`), the classroom of the last poll — remembered per
  browser in `localStorage`, never in the URL or on the server. `values` is
  the closed list of choices (or a predicate for an open set, an id); anything
  else stored gives `fallback`. Both accessors are wrapped: a private window
  or blocked site data makes `localStorage` THROW, and a remembered habit is
  never worth a crash — the page simply starts on the fallback. It exists
  because five screens wrote that reader by hand, and two of them crashed in
  a private window. The storage keys are the ones those screens always used,
  so nobody loses a remembered view. The theme, the locale mirror and the
  notification preferences, which are not choices of this shape, go through
  the same guarded `readStored` / `writeStored` / `removeStored`: a guard on
  the page is worth nothing if the boot crashed first.
- `isTyping(target)`: a single-letter shortcut (`f`, `r`, `v`, an arrow) is
  not one while the keystroke lands in an input, a textarea, a select or a
  contenteditable surface — there it is a letter the reader is writing. Every
  screen-wide key handler asks it first; four screens used to spell it out.
- `useFullscreen()`: the page-level full screen (a `fixed inset-0` stage,
  which is all a projector needs) with the browser's own `requestFullscreen`
  attempted on top and its refusal swallowed. It LISTENS to
  `fullscreenchange`, because Escape, F11 and the browser's chrome leave the
  browser full screen without telling the page: the state must follow the
  browser out, or the reader is left inside an overlay whose button says
  "Leave full screen" about a full screen already gone. The live dashboard's
  private copy lacked that listener and did exactly that; the poll projection
  and the dashboard now share this one.

## Components

- Button: `primary` (accent fill, white text, one per screen), `secondary`
  (surface, hairline), `ghost` (no chrome), `danger` (danger fill, never
  primary-styled elsewhere), `danger-quiet` (surface, red ink and hairline,
  `danger-soft` on hover): the trigger in a settings row of an action whose
  confirmation is the `danger` dialog — delete, remove, disconnect, unlink.
  The row reads as destructive without a second red fill competing with the
  screen's one accent; the fill belongs to the confirmation. A reversible
  action (archive) stays `secondary`. A deletion that destroys the only
  copy of something (a classroom whose Quiz-mode journal holds pages, that
  journal itself: F-ORG-09, F-JRN-04) asks for the classroom's name in the
  same dialog (`useConfirm({ typeToConfirm })`): one field under the
  message, the `danger` button off until the name matches.
  Sizes `sm` 28 px, `md` 34 px, `lg` 40 px.
  Pressed to 0.97. The class list is `buttonClass` in `@quiz/ui`, which the
  app's `Button` and `LinkButton` and the question types all wear.
- Icon button: round, ghost; `danger` turns red on hover only. Its disc as
  a link to a page outside the app, in a new tab, is `IconLink` — a
  project's two repositories on GitHub on its row (M3-14h); its label is
  its tooltip and accessible name, as an icon button's.
- Mode banner (`ModeBanner` in `Shell.tsx`, #200): a mode of the whole
  application — the student view, acting as someone else, the teacher's
  preview of an evaluation (ADR-018, seventh addendum) — is stated above
  everything, not as a page notice. Full width over the sidebar,
  sticky at the top (`Z.banner`, above the sticky bars, under the coach and
  every dialog), 32 px high, 12 px medium text, a message (a short one under
  `sm`, so a phone still reads the word that names the mode; truncation is the
  fallback) and one compact 24 px outline pill for the way out — or, in the
  preview, whose way out is the player's own Home, for Restart. A fixed
  overlay of the page under it (the paused attempt, the preview's grading)
  starts at `--banner-h`, so the way out stays reachable. Solid **`fg` fill with
  `canvas` ink** (about 16:1 in both themes, since both tokens swap):
  inverted rather than red, because the one red element of a screen is the
  thing to click, and a mode is not something to click. The pill's focus
  ring is `canvas` instead of the accent — the one exception to the focus
  rule, because the accent on `fg` is about 2.5:1 in light mode, under the
  3:1 a ring needs. The banner hands its frame `--banner-h` (0 elsewhere, in
  `style.css`); the sidebar, the phone top bar and the player's header stick
  at that offset, and the full-height columns subtract it. Banners stack:
  each sticks at the `--banner-h` it inherits (`--banner-top`) and hands its
  frame the sum, so Super Powers above the student view read as two strips.
  ONE banner is red (`tone="danger"`: `danger` fill, `on-fill` ink, 5.9:1 /
  6.4:1): Super Powers (ADR-054), a hazard rather than a point of view —
  every colleague's course is one click away. Its `aside` slot carries the
  time left: minutes, then in the last five a bold countdown by the second
  behind a warning sign; the pill's ring and hairline follow the ink.
- Badge: pill, soft background, 12 px, tones green / amber / red / zinc /
  accent. Status is a badge; a count is plain text. The accent tone is
  rarely right: on the student's activity cards it is never used (the button
  alone carries it, see "The student's activity card"). A badge that is also the door to
  its own fix — "template rev. 1 → 3" on a classroom's evaluation row
  (F-EVAL-26) — is the same badge wrapped in a `button` with an accessible
  name that says the action; it stops the row's click, and it is shown only
  where the fix would be accepted.
- Card: `surface` + hairline + 16 px radius; padding 16–20.
- NotePanel: a note set INSIDE a card — an explanation, a teacher's comment,
  a reference solution — as a 12 px uppercase semibold eyebrow in `fg-faint`
  over its body, in a `field`-radius (10 px) panel. ONE rhythm: **12 px of
  padding, 4 px between the eyebrow and the body** — the "tight inside a
  group" end of the spacing scale, since the panel is one group nested in a
  card that already has its 16–20 of air. Two tones: `soft` (`surface-2`, a
  recess) for what the product says, and `outlined` (a `line-strong` hairline
  on `surface`) for what a person wrote to this reader. It exists because
  five such panels were written by hand with two paddings (12 and 16) and
  two gaps (4 and 6).
- PersonAvatar: a person as a round picture, or their two initials on
  `surface-3` in `fg-muted` when there is no picture OR when it fails to load
  (an IdP picture URL goes stale, and a broken-image glyph is not a face).
  The signed-in user's own disc (`Avatar`) takes the `accent` tone. An
  avatar standing alone — the row of a course's staff — carries the full
  name as its accessible name and as a `Tip`, never a native `title`; one
  with the name written beside it (a roster row) carries neither. A picture
  that loaded shows larger on hover — at most 176 px, never upscaled — with
  the name in the same bubble; initials never do, nor does a touch screen. It
  exists because three places drew "a picture, or initials", and two of them
  had no fallback.
- OrgAvatar: an organization — a GitHub organization, the owner of a
  classroom's repositories — as its picture, or its initials (the first
  letter of the first two words of the login, `heig-tin-info` ⇒ HT) on
  `surface-3` in `fg-muted` when there is none or it fails to load: the same
  `Initials` and the same fallback as a person. It is a **soft square, not a
  disc**: a disc is a person, and an organization next to a person must not
  read as one more face. `xs` 16 px (the sidebar) and `sm` 24 px (a list
  row) take `rounded-key`, `md` 36 px (a page header) `rounded-field`, so
  the three stay the same shape. At 16 px it writes one letter, not two: two
  letters at that size are a smudge. Decorative, the name is beside it. The
  picture is a same-origin URL the API serves; the browser never loads
  github.com, which would hand GitHub the viewer's IP — with no URL, it is
  the initials.
- Avatar initials below the type scale: 9 px in the 16 px `OrgAvatar`, 10 px
  in the 24 px one. The 12 px caption step would overflow a box that small;
  these are glyphs in a badge, not text to read, and exist nowhere else.
- GithubIcon (`ui/identity.tsx`): the GitHub mark, which lucide no longer
  carries, in `currentColor`. It is an `IconType`, so it goes wherever a
  lucide icon goes, and it is drawn to the same optical size: its view box
  leaves the one-twelfth margin a lucide glyph has inside its 24 units, so
  at `size-4` it sits beside a `Pencil` without looking one step larger.
  It marks what is GitHub's (a repository link, the "Connect GitHub"
  button); it is never the accent.
- Progress: a job that takes seconds and whose length is unknown — a
  repository being explored — as a thin bar (4 px, pill ends, `surface-3`
  track) under a 13 px `fg-muted` label: a third of the track slides across,
  and no number is invented. The fill is `info`, not the accent: progress
  is the job `info` already does in a `VerdictCell`, and a red bar would be
  one more red thing on a screen whose red thing is the button.
  `role="progressbar"`, named by the label, `aria-busy`, no value. Under
  reduced motion it stops sliding and fills the track at low opacity. A
  determinate bar is a `SegmentedBar` with an `info` part.
- PersonPill / PeopleStack: a group of people as a row of 24 px discs — the
  staff of a course, the teachers of a classroom. A disc carries the name in a
  `Tip` and nothing else, because a name is all a reader wants while scanning;
  the address and whatever may be done to that person's seat wait inside the
  `Popover` the disc opens, where they cost the row nothing and where the name
  is already written beside them. Those actions go through `Actions`, so one
  of them is one icon button. The row has a ceiling (`max`, ten): past it the
  rest becomes a single "+N" disc in the `Initials` colours, opening on the
  WHOLE list, one line per person. It exists because the staff used to be a
  hairline-separated strip under the classrooms with the word STAFF over three
  discs, and "remove Pierre Roulet from the staff" was an item in the course's
  own menu — an action about a person, filed under the thing they are on.
- MetaItem / MetaLine (`ui/meta.tsx`): the small facts under a title — a
  deadline, a commit, a score. An item is an icon (lucide, `size-3.5`,
  `fg-faint`, decoration) and its text at 13 px `fg-muted`; an icon never
  carries a meaning the text lacks (a frozen score says "at the deadline" in
  words). A `MetaLine` wraps its items (16 px between, 4 px between wrapped
  rows). A badge may sit among them (the CI status). `IconTip` is the other
  icon of this family: an icon that stands for a word (a card's kind), an
  image named for a screen reader and by a `Tip` on hover, not a tab stop.
- Breadcrumb (`ui/breadcrumb.tsx`, drawn through `src/Trail.tsx`): the trail
  of a page, in the `PageHeader` eyebrow, `Courses › PRG1 › PRG1-2026 › Quiz 3
  › Results`. It replaced `ParentLink` (the single "one level up" button) in
  the whole app, staff pages included (product owner, 2026-10-06). A `nav`
  named by the caller (`breadcrumb.label`, translated), an ordered list;
  ancestors are real links (`href` from `routeToPath`, routed in the app on a
  plain click), the last item is the page, `aria-current="page"`, in `fg`. The
  `ChevronRight` separator is decorative (`aria-hidden`). From `sm` up the
  trail keeps one line: ancestors truncate first, the page last. Below `sm`
  (a phone) a full trail is unreadable, so the SAME `nav` shows only the way
  back, `‹ Parent`, one link to the immediate parent (`ChevronLeft`, its real
  `href`, named "Back to <parent>"); the list is hidden there, the page's own
  heading being right below. The rule:
  1. A page below a top-level section wears a trail; a top-level page (a
     sidebar destination: Activities, Courses, Question pools, Poll,
     Administration; the student's Courses, Grades, Drill) wears none.
  2. The trail is STRUCTURAL, not the browsing history: its root is the
     sidebar section the page belongs to (`SECTION_ROOTS` in `Trail.tsx`, the
     list the sidebar reads its labels from: Courses for course, classroom,
     evaluation, project, results and group pages; Question pools for pools,
     categories and questions), then each ancestor down to the page itself.
     Staff: `Courses › PRG1 › PRG1-2026 › Quiz 3 › Results`, `Question pools
     › Pointeurs › Categories`. Student: `Courses › PRG1-2026 › Project`.
     Two pages bend it because the way back they offered is a flow, not a
     place: the question editor opened from an evaluation, a template or the
     grading screen wears THAT page's own trail then the question (`Courses ›
     PRG1 › PRG1-2026 › Quiz 3 › Grading › question`), and a group set opened
     from a project puts the project in place of Groups.
  3. Names are what the page already loads (the classroom query is shared by
     every classroom screen, `classroomKey`). A course is its CODE (short:
     `PRG1`), a classroom its name, an evaluation its title. An ancestor not
     yet loaded is left out, never fetched crumb by crumb; the hooks of
     `Trail.tsx` (`useClassroomCrumbs`, `useEvaluationCrumbs`,
     `useTemplateCrumbs`) return what is known, a page appends its own.
  4. No crumb leads to a page the reader may not open: a student's trail
     holds student routes only, and a teacher in the student view gets it.
  The journal reader keeps its compact header: the same trail, in a wrapper
  of the eyebrow's own 13 px `fg-muted`, above the tabs. The evaluation
  preview pages keep their "Back to the evaluation" button: a preview is not
  a page of the app's tree.
- EditableTitle: a page title renamed where it is written — the evaluation,
  the template, the classroom, the course. A real button at the `h1`'s own
  type, a `PenLine` in `fg-faint` fading in on hover and focus, swapped on a
  click (or F2) for an input of the same size with the whole title selected.
  Enter or blur saves, Escape cancels, a blank title reverts; the title being
  saved stays on screen until the refetch lands. Its accessible name says the
  action AND the name ("Rename course “Programmation C”"), since it is the
  whole text of the heading. Never the accent: it is not the page's primary.
- Logo: the product's wordmark (`src/assets/quiz.svg`), four speech bubbles
  spelling Q U I Z, inlined from the file as `role="img"` named "Quiz". It
  is the file, not retyped JSX: the same mark is delivered elsewhere, and a
  retyped copy is a second version to keep in step. Each bubble is a group
  of the file, so under the pointer the four of them dance for fun (the Q
  pecks, the U bounces, the i and the z squabble; 1.6 s rounds, ending on
  the rest pose) — the one decoration allowed outside the motion rules
  above, and off under `prefers-reduced-motion`. Its four colours are its own and live outside the
  token scale — nothing else on a screen may use them. `className` carries
  the WIDTH and the height follows, because it is a drawn word and is sized
  like a word: 100 % of the sidebar (about 200 px), 112 px in the phone top
  bar and in the drawer (the folded sidebar shows the Q bubble alone, the
  favicon's file, 28 px: the wordmark at 40 px is four dots), 220 px on
  the signed-out page, where it IS the `h1` and the 28 px title under it
  is gone — it said "Quiz" a second time.
- Alert: hairline + soft tone fill, an icon, a title and one paragraph. Its
  `action` slot holds one button, beside the text from `sm` up and on a line
  of its own below it: a long label inline squeezes the body to one word per
  line on a phone. Nothing goes in an Alert body that belongs in `action`.
- QueryError: the standard failed-query alert (`Alert tone="danger"` +
  `apiErrorMessage` + a secondary Retry). Every query error state uses it, so
  a failure reads the same everywhere and there is one place to change it.
  Queries retry once and never on a 4xx (`main.tsx`), so the error state
  arrives in about a second: three retries read as a hang, not as a failure.
- FormError: QueryError's counterpart for a WRITE that failed, said where
  the reader acted — nothing while the mutation's `error` is null, otherwise
  the server's message or the fallback. Without a title it is one 13 px
  `danger` line, the shape a dialog puts under its fields (`FormDialog`'s
  `error` slot); with a `title` it is a danger `Alert`, the shape a step, a
  sheet or a page uses, where a bare red line would be lost. It exists
  because seventeen sites spelled out `isError ? … apiErrorMessage … : null`
  by hand. It lives beside QueryError (`queryError.tsx`), for the same
  reason: `ui/` never imports the HTTP client.
- Field: label 13 px 500 above, 10 px radius (`rounded-field`), `line-strong` border, accent
  ring on focus. The `<label>` covers the text only and points at the control
  through `htmlFor`; the help "?" is its sibling, never inside it, or that
  button becomes the labelled control and the input loses its name. Two heights, from the button scale: `sm` 28 px for a control
  inside a table row, `md` 34 px everywhere else (`inputSize`). A textarea
  is `textareaClass`: the same chrome, 8 px of vertical padding, the relaxed
  line height, and its rows for a height. `inputClass`, `inputSize`,
  `textareaClass` and the label row are written once, in `@quiz/ui`, and
  `ui/controls.tsx` re-exports them: a field in a question editor IS the
  field of every other form of the app, not a copy that may drift.
  Width is a prop, never a class beside `inputClass`: Tailwind settles two
  width or height utilities on one element by their order in the generated
  stylesheet, not by the order they were written in.
- Help of a whole page (`PageHeader`'s `help`, `PageHelpButton`): a round
  34 px button outlined like a secondary one, in the header's action row,
  after the page's actions and before the overflow "…" — never beside the
  h1. "?" and "…" wrap together on a phone, never apart. The title is renamed in place, carries badges and wraps on a phone; a
  "?" riding it never sat right, the action row does not move.
- Help "?" (`HelpIcon`): **16 px**, `fg-faint` at rest, accent on hover, the
  same beside a 16 px section heading, a dialog title and a 13 px field
  label — it is a mark next to a word, not an action of its own, and one size
  is what makes it read as the same mark everywhere. It is placed by the
  component and never by the call site, which only says WHICH topic. Its rows
  are `flex … items-center`, and `items-center` centers it on the LINE BOX,
  whose middle sits above the middle of the letters (the box carries the
  descender space and the leading): the icon is therefore pushed back down by
  `0.0625em`, onto the letters, between the cap-height middle and the
  x-height middle. In `em` because the error it corrects is a fraction of the
  font size, so one value holds at 13 px and at 28 px.
- ToggleChip: a value you switch on, as a pill — `border-line-strong` on
  `surface` in `fg-muted` at rest, `accent-soft` on an `accent` border in
  `accent` when pressed, 28 px tall, 13 px, an optional leading icon.
  Containers lay them out with `flex flex-wrap gap-2`. It exists because a
  column of checkboxes is the shape of independent SETTINGS, and the filter
  sheet holds SETS — the type of a question, a difficulty, a tag: the reader
  wants to see what is on at a glance, and two-word labels beside small boxes
  collided the moment the sheet was narrower than the longest of them. It is
  a real `aria-pressed` button, so the state and the label are never
  separated; `pressed` left undefined drops `aria-pressed` for the one pill
  in a row that is an action and not a value ("Show all (37)").
  `tone="neutral"` is the same pill pressed as a solid `fg` fill with
  `surface` text (the progress strip's "done" segment): for a screen whose
  one accent is spoken for — the player's
  answer tools (Leave unanswered, Clear), which must read as buttons and
  as on/off without ever out-shouting Next (issue #128). The review flag is
  not one of them: it belongs to the question, not to the answer, and is an
  `IconButton` with `aria-pressed` floated in the card's top-right corner,
  filled in `fg` when on (the favourite star's recipe).
- Segmented: `surface-3` pill track, selected chip raised to `surface`.
  Segmented is ONE choice out of a set small enough to show whole — two or
  three normally, five at most and only with one-word labels (the pool
  toolbar's "Group by"); ToggleChip is any number out of many. One
  exception: the drill's "How sure are you?" scale (ADR-085), five short
  levels of one scale ("Fairly sure" is the longest), `sm`, which fits
  390 px in both languages and scrolls inside its row below that. Its
  value starts EMPTY (no pill selected) and a digit pressed again clears
  it: an optional statement must not have a default.
  Do not use one for the other's job, and do not reach for a `Select` just
  because there are four options: a select hides the set until it is opened,
  which is the wrong trade for a control the reader sets once and then reads.
  A track with no visible caption takes `label`, which becomes the
  `aria-label` of the radiogroup — two anonymous pill rows side by side are
  indistinguishable to a screen reader; one with a caption points at it with
  `labelledBy`. `size="sm"` (24 px chips) is for a dense toolbar; `wrap`
  lets the chips fall on a second row, and the track then takes the card
  radius, since a pill two rows tall is a lens. One component, in
  `@quiz/ui`, for the app and the question editors alike.
- Switch: `success` when on (a state, not an action, so not the accent),
  `line-strong` when off.
- Tabs: text tabs with a 2 px ink (`fg`) underline, counts in `fg-faint`; red
  stays for actions. When the strip is wider than the screen it scrolls, the
  hidden side is faded out over 36 px (a mask, so it works on either theme)
  and the tabs snap: a fourth tab must never simply stop at the screen edge.
- Row grip: the handle that reorders a list of rows (the evaluation's items,
  an mcq's choices), at the LEFT of the row, `GripVertical` in `fg-faint` on a
  28 px round hover target. It is a real `<button>` carrying the @dnd-kit
  listeners, which is the whole point: the keyboard sensor reorders through
  that same affordance (focus, Space, arrows, Space), so the ↑ / ↓ pair it
  replaces is removed rather than kept beside it — two controls for one
  gesture means one of them is lying. Pointer sensor at 4 px of slop so a
  click in the row is still a click, and `restrictToVerticalAxis`.
- Milestone separator: the evaluation's `milestone` boolean, drawn as a BAND
  across the list under the row it belongs to — `surface-2`, a dashed
  `line-strong` hairline, a `Flag` and the word in 11 px uppercase
  `fg-muted`, an × at the end. Not red: the one accent on that screen is
  "Add questions", and a rule in brand red running across a list wins the
  squint test against it. The way to make one is a "+" pill revealed in the
  GAP it would fill (row hover, its own focus, or always under a coarse
  pointer), because a section break is a thing you put BETWEEN two rows, not
  a property you tick on one.
- Settings row: label and the description of the current choice on the left,
  the control on the right. The row wraps rather than squeezing — the text
  keeps a 14 rem floor, so a segmented control or a select drops to its own
  line on a phone while a switch stays on the label's line at any width.
- Tabs keep the selected tab in sight: a strip wider than a phone scrolls
  itself (never the page) to the selected tab, so a route that opens on a
  fourth tab shows it.
- Sheet: right drawer, 560 px, for every form longer than three fields.
  Dialog: centered, ≤ 480 px, for confirmations and one-field forms.
  A sheet never opens another sheet; a dialog may open over a sheet.
  A sheet may dock ONE reading pane on its left edge (`Sheet aside`), part
  of the same dialog — same focus trap, same Escape — never a second layer:
  the question picker shows there the question last clicked, as a student
  reads it. The drawer keeps its width and the pane (480 px, 640 px from
  `2xl`) takes the blurred page beside it, so it exists only from 1280 px
  (`ASIDE_MIN_WIDTH`); narrower, the caller shows the same content in place
  of the sheet's body, with a Back button. No empty pane: it appears on the
  first look.
  One exception, `size="xl" scroll`: a READING dialog, 920 px, whose body
  scrolls under a title and a footer that stay put. It is not a form — it is
  a document the reader walks through, today the whole of one student's
  answers opened from the live grid — and the footer is how they walk to the
  next one, so it must not sit at the bottom of a hundred lines of code.
  The Safe Exam Browser launch of an exam (`SebLaunchModal`) is the second
  reader: its steps and an exam's conditions, which can run to twenty lines.
  From `lg` the steps hold a left column that stays put (`sticky`) while the
  conditions scroll beside them, so a laptop screen 640 px tall shows the steps,
  the conditions' start and the download without a scroll; narrower, the
  steps come first and the conditions follow under their heading. Without
  conditions (a workspace's file) it stays a 520 px dialog.
- FormDialog (`ui/forms.tsx`): the short form in a dialog — one to three
  fields, Cancel (`common.cancel`, always) and ONE submit button whose label
  is the verb ("Create course", "Save"), spinner while `submitting`, disabled
  until `canSubmit`, and the failure under the fields. It exists because
  seven dialogs wrote that footer out by hand, each one a chance to drift.
  It deliberately has no `size`: a fourth field is
  the sign the form belongs in a `Sheet`, never a reason to widen the
  dialog. `dense` (12 px between rows instead of 16) is for a body that is a
  single row.
- Menu: overflow for tertiary actions; destructive items last, separated. A
  list longer than the room left under (or above) its trigger scrolls inside
  the panel, capped at the viewport (a set's thirty groups to move a
  student into, M3-16a). It
  closes on a page scroll, but not on the scroll its own opening click causes
  (200 ms of grace) nor on one inside the panel. Its panel stacks ABOVE the
  dialog layer (`Z.popover` > `Z.modal`), because menus open from inside
  sheets, dialogs and the mobile drawer. An item may carry a `description`,
  a second 12 px muted line, when the label alone loses what the action does.
  An item's `disabled` describes the state when the menu was opened, never a
  busy state: picking an item closes the menu, so a pending flag there is
  invisible. A toast reports the progress instead.
- Actions: the actions of ONE record — a course, a pool, a table row — drawn
  as the shape their NUMBER deserves: one or two icon buttons side by side,
  the `Menu` from three on. The call site hands over the list and never picks
  the shape, which is what makes "a row of three or more icon buttons is a
  menu" true by construction instead of true by review; it also means the
  same list drawn on a card and in a table row cannot come out as two
  different things. An item that cannot be a button — no icon, or an `href`
  or a `description`, which are rows of text — sends the whole list to the
  menu, and so does `menu`, for a list whose length varies with the state and
  would otherwise flicker between two shapes under the reader's pointer. It
  exists because "how many is too many" was being answered by hand at every
  site, and the answers had started to differ.
- Popover: a small floating card hung on a trigger — a colleague's name and
  address behind their disc, the list behind a "+2". Built from the same two
  pieces as `Menu` (`menuPosition`, `useLayer`), so it closes on the same four
  things (outside click, Escape, page scroll, resize) and its panel wears the
  same chrome: `menu` radius, hairline, popover shadow, `Z.popover`, 12 px of
  padding, 14 rem wide at least and 20 at most. It is a `dialog` and not a
  `menu` — what it holds is a card one may act IN, which arrows do not walk.
  Two ways in: `click` for what a reader goes looking for, `hover` (150 ms in,
  150 ms of grace out, so the pointer can travel the 6 px gap) for what a
  pointer brushes past. A hover popover is still clickable, because a touch
  screen has no hover at all. A bare label is a `Tip`, not this.
- Combobox (`ui/combobox.tsx`): a text field with a list under it — the tag
  field, the teacher picker, the pool search's `tag:` / `type:` completions.
  `useCombobox` holds the ARIA combobox with virtual focus: `role="combobox"`,
  `aria-expanded`, `aria-activedescendant` naming the highlighted option, the
  caret never leaving the input; ArrowUp/ArrowDown wrap through
  `listboxIndex`, Home/End stay the caret's, Enter picks a highlighted row
  and otherwise belongs to the field (a form submits, a tag is added),
  Escape closes. Two kinds, because they open for different reasons. A
  **picker** follows the focus: focus or an arrow opens it, its loading and
  empty rows show, and it outlives the blur by 120 ms so a click on a row
  lands. A **completion** list (`completion`) follows the text: it shows only
  while there is something to complete, the focus and the arrows do not
  bring back a dismissed one, the blur closes it at once, and Escape stops
  there rather than reaching the page. `ComboboxList` is the panel: `menu`
  radius, hairline, popover shadow, `Z.popover` (it opens inside sheets),
  4 px under the field, as wide as the field unless placed otherwise, capped
  at 288 px — eight 14 px rows, the completion list's limit, fit without a
  scrollbar. `ComboboxOption` is the row, in the shape of the command
  palette's and the sidebar's: 14 px, `field` radius, the highlighted row the
  `accent-soft` chip in semibold `accent`, the others `fg-muted` with a
  `surface-2` hover; `mousemove` (never `mouseenter`) moves the highlight.
  What a pick does — close, stay open for another tag — is the call site's.
  It exists because three comboboxes wrote the pattern out by hand and had
  started to disagree on the panel and the highlighted row.
- Toast: bottom-right, above the student's bottom bar when it is up
  (`--bottom-nav-h`), `surface` + hairline + overlay shadow. Tones
  `success` / `error` / `warning`, plus `progress` (a neutral spinner) for
  "this has started", which is the only report an action taken from a menu
  can get. A failed mutation reports through `useErrorToast()` (`notify.tsx`):
  `onError: toastError("error.save")` — the server's message or the
  translated fallback key, always in the `error` tone, so no call site can
  pick another one. A toast may carry ONE action (`toast(message, tone, {
  action, key })`): a 13 px semibold `fg` text button before the dismiss
  cross — never the accent, the screen's red is elsewhere —, which runs and
  dismisses the toast. Today it is Undo after a group set's move (ADR-070
  §6), for the toast's 6 s; `key` makes a toast replace the one standing
  with the same key, so only the latest move offers Undo.
- Group board (`group/GroupBoard.tsx`, M3-16a): a group set's students in
  no group and its groups, as the categorize board draws its tray and
  columns (`ColumnFrame`'s hairline card, the chip of a categorize card,
  `info` for the selected student and the "Move here" buttons, `info-soft`
  under a drag). "No group" is a 16 rem column that stays in sight from
  `lg` (sticky under the banner, its own list scrolling past the screen);
  the groups wrap in a 13 rem grid (`items-start`: a pair is not stretched
  to the tallest group of its row), so a class of a hundred is some thirty
  cards and no horizontal scroll. Each student has a "Move to…" menu, the
  keyboard's and the phone's way, beside the drag. A group above the set's
  maximum shows its count in `warning` and a `TriangleAlert`: a warning,
  never a refusal. A student who has not signed in carries a faint
  `CircleDashed`. Read-only (an archived classroom): plain chips, no menu.
- Empty state: icon in a `surface-2` circle, title, one line, one action.
- PageSkeleton: the loading state of a whole page, in ONE shape — a 32 px
  title bar, optionally the 36 px tabs/toolbar row under it, then a 256 px
  block, optionally under a 96 px summary strip for a page that opens on
  figures (results, the student's feedback); 24 px between the rows, the
  header-to-body gap above. The widths mean nothing and are the same on every
  page: a skeleton says "a page is coming", and six pages each guessing their
  own proportions said nothing more. The skeletons that DO mirror their
  content keep their own shape — the pool's table and cards
  (`QuestionTableSkeleton`, `QuestionCardsSkeleton`), the grading list
  (`ListSkeleton`) and the projection's stage — because there the rows are
  the promise.
- Notification bell (`src/notifications/NotificationBell.tsx`): the account's
  own inbox, beside the account row in the sidebar and beside the avatar in
  the phone top bar — the two things that are about the PERSON and not about
  the page. Its panel is NOT a `Menu`: the rows are sentences carrying a
  `RelativeTime` and a read mark, which a `MenuItem` cannot hold, so it is
  built from the same two pieces (`menuPosition`, `useLayer`) as a
  `role="dialog"` layer, 352 px wide, capped at 60 dvh and clamped to the
  16 px page gutter — anchored on a trigger 20 px from the right edge of a
  phone, the panel otherwise hangs off the screen. The unread COUNT is the
  one count in the product that wears the accent FILL rather than being plain
  text: it sits on an icon, where there is no room for a word, and it is the
  one thing on that row that is new. Capped at "9+". An unread ROW, in
  contrast, is marked by a 6 px accent dot and a semibold sentence, never by
  a tinted row: a column of red-tinted rows would beat the count itself at
  the squint test.
- Pool card and pool icon: a pool is a spine on a shelf, so its ICON is the
  identity — 24 px in a 44 px `surface-2` tile, over a 14 px bold name and
  12 px muted facts. The card is ONE button (the door) with the overflow menu
  beside it, never inside it, and the cards of a row are a flex column each
  so the "Updated …" strip lands at the same height on all of them. The icon
  is a lucide NAME stored on the pool (`src/pool/poolIcons.ts` holds the
  curated shelf of about thirty school and technical subjects) and drawn by
  `PoolIcon.tsx`, which takes two paths: a STATIC map for the curated names,
  because those are the ones on every card and they must be there in the
  first frame, and lucide's `DynamicIcon`, loaded lazily, for a pool wearing
  one of the other 1500. The split is measured, not a preference —
  `DynamicIcon` alone put 250 kB (62 kB gzipped) of lazy-import map inside
  the pools page chunk and rendered nothing until an `import()` resolved,
  where thirty real imports cost about 3 kB and paint at once. Visibility
  is a `Badge`: zinc for `private` and `shared with n`, amber for `public` —
  the one state where a stranger reads your questions is the one worth a
  second glance, and neither may take the accent, which belongs to "New pool".
- Icon picker: one dialog, two steps — the curated shelf, then the whole
  lucide catalogue behind a search box (`fuzzyFilter`, 120 results drawn,
  scrolled), which is a `lazy()` module of its own so the catalogue is
  downloaded by the teacher who asks for it and by nobody else. Not a second
  window: "more" is the same decision seen wider.
  Picking IS the action, so the dialog has no primary button; the footer only
  changes step. A tile is a value you switch on and wears the `ToggleChip`
  language at rest (a hairline), but its pressed state is an INK ring — `fg`
  border plus a 1 px `fg` ring on `surface-2` — and not the accent: the tile
  draws its icon in the pool's colour, and a red border around a red icon
  says nothing. A tile's label is the RAW lucide name (`flask-conical`),
  untranslated on purpose: it is an identifier, like a SHA or a tag, and in
  the search step it is the very string the reader typed.
- Pool colour (#213): the colour of the ICON, and of nothing else — never
  the card, the name or a page header. Grey is the default and is `null`,
  like the default icon, so a pool nobody coloured looks as it always did
  (the call site's `fg-muted` / `fg-faint`). The fifteen others are a closed
  set of NAMES (`PoolColor` in `@quiz/contracts`), each a `--pool-<name>`
  token swapped under `html.dark`, never a stored hex, and set INLINE
  (`color: var(--pool-teal)`) — it then wins over the call site's grey ink
  without a class map for Tailwind to find. Decoration only
  (N-A11Y-03): the name and the icon stay the identifiers. The colours come
  first in the icon picker, as a row of round swatches — native radios, so
  the arrow keys walk the row and Tab leaves it in one step, each named in
  both languages — and every tile previews its icon in the colour being
  chosen; no second button appears. The
  chosen swatch is ringed in ink with a 2 px `surface` offset, and the
  focused one outlined in ink too, for the same reason as the tile. The
  colour is set in the form like the icon: a swatch changes it at once, so a
  colour alone is picked and saved without touching the icon. Held to 3:1 (a graphic object) on `surface` and on
  `surface-2`, the card's icon well. The values are hand-picked, not a
  palette's one shade: at 20 px the stock 600/700 shades gave near-twins
  (amber and yellow both brown, violet and purple at a CIE94 ΔE of 3), so each
  neighbour is pulled apart in hue AND lightness — no two colours closer than
  ΔE94 9.7 in light, 9.0 in dark — the yellow is a saturated gold that still
  holds 3:1, and the three blues step down in lightness (sky, blue, indigo):

  | Colour | Light | on `surface` / `surface-2` | Dark | on `surface` / `surface-2` |
  | --- | --- | --- | --- | --- |
  | red | `#d42424` | 5.15 / 4.57 | `#f87171` | 6.29 / 5.75 |
  | orange | `#e05a00` | 3.73 / 3.31 | `#fb923c` | 7.68 / 7.02 |
  | amber | `#b87000` | 3.92 / 3.48 | `#f5b000` | 9.19 / 8.40 |
  | yellow | `#9e8800` | 3.51 / 3.12 | `#ede04a` | 12.72 / 11.63 |
  | lime | `#5a8c00` | 4.05 / 3.59 | `#a3e635` | 11.53 / 10.54 |
  | green | `#1f8a3a` | 4.42 / 3.92 | `#5ccf5c` | 8.72 / 7.97 |
  | emerald | `#00876a` | 4.49 / 3.98 | `#34d399` | 9.05 / 8.27 |
  | teal | `#00868e` | 4.37 / 3.88 | `#2dd4bf` | 9.34 / 8.54 |
  | cyan | `#0086b3` | 4.15 / 3.68 | `#22d3ee` | 9.62 / 8.80 |
  | sky | `#2f7fe6` | 3.96 / 3.51 | `#38bdf8` | 8.12 / 7.42 |
  | blue | `#2244cc` | 7.59 / 6.73 | `#5b8dfa` | 5.49 / 5.02 |
  | indigo | `#3f2a9e` | 10.31 / 9.14 | `#8f7cf0` | 5.22 / 4.78 |
  | violet | `#8a3ce6` | 5.43 / 4.81 | `#c490f0` | 7.12 / 6.51 |
  | purple | `#b0209e` | 5.92 / 5.25 | `#e070d8` | 6.19 / 5.66 |
  | pink | `#e0306e` | 4.36 / 3.86 | `#f472b6` | 6.57 / 6.00 |
- Kbd: a key cap for the places that teach a shortcut — 6 px radius, hairline,
  `surface-2`, 11 px / 500 in `fg-muted`, 6 px horizontal padding. `font-sans`,
  not mono: the mono face is reserved for SHAs, repository names and what a
  student copies, and a key is a picture, not a string.
- Command palette: Ctrl/⌘+K, 620 px, anchored at 12 vh instead of centered.
  Top-anchored because the list grows downward — a centered panel moves its
  first row every time the query changes — and because 12 vh keeps it clear of
  the mobile keyboard. It is a navigation layer, so it closes on the backdrop
  too: it holds nothing the reader wrote beyond a query they retype in a
  second. The search row carries no field chrome (no border, no ring): the
  whole 52 px top band is the field, and a second border inside a bordered
  panel is noise. The active row is the screen's single accent use, the same
  `accent-soft` chip a selected sidebar item wears, so the squint test shows
  exactly what Enter will run. Virtual focus: the focus never leaves the
  input, the rows are out of the Tab order, and `aria-activedescendant` on the
  input carries the selection. The list is capped at **60 dvh** and scrolls
  past it — `dvh` and not `vh`, because a soft keyboard shrinks the dynamic
  viewport and a cap read from the static one leaves the last rows under the
  keyboard; 60 keeps the 12 vh anchor, the search band and the footer on
  screen at any height. Like every other `Z.modal` layer it locks the page
  scroll: a panel anchored at 12 dvh of a viewport moving under it is not
  anchored to anything.

- Countdown: the time left on a deadline the **server** owns. `now` is a
  prop, never `Date.now()`, so two countdowns on a screen agree and both
  follow `useServerClock`. Tabular digits, `warning` under the evaluation's
  threshold, `danger` under a minute whatever that threshold says, `0:00` and
  never a negative. The phase is also announced once, when it is crossed,
  through a polite live region: the colour change alone reaches neither a
  screen reader nor a red-green reader. On a live screen use
  `ClockCountdown`: it takes a stable `clock` function (the server's) instead
  of `now` and ticks by itself on the one shared timer of `useNow`, so the
  tick re-renders the digits and not the question or the grid around them.
  Never tick a page to feed a countdown.
- Ring: SVG progress ring for the lobby's "present / enrolled" and the
  dashboard's completion. `fg` and not the accent — on the waiting screen it
  is the only living element, and a red disc would read as an alarm on a page
  whose whole message is "there is nothing to do". `label` names the figure;
  the middle is `aria-hidden`, or the reader hears the numbers twice.
- ProgressSegments: a stepper in the zen player, one circle per question —
  the student's question list (issues #89, #219). Each circle carries FOUR
  independent facts. Its mark is a SHAPE before it is a tint, so it reads in
  grey and to a colour-blind student: answered is a solid `fg` circle with a
  check in `surface` ink; "left unanswered" a dashed `fg-muted` circle on
  `surface-3` with a dash; nothing yet a hollow `fg-faint` circle (not
  `line-strong`, which misses 3:1 against the canvas in dark mode). A
  flagged question carries a solid `Flag` in `warning` beside its number —
  never thinned out, it is the one mark the student set to find the
  question again. The current question wears an `accent` border and a 4 px
  `accent-soft` halo over whatever its mark is, an accent dot inside when it
  holds nothing yet, and its number in bold accent; a question the
  navigation closed drops to 45 % opacity. The circles are joined edge to
  edge (never under a circle, which a faded one would let show through): a
  1 px `line-strong` hairline, drawn as a solid 2 px `fg` stroke between two
  questions already dealt with (answered or declined), so the path covered
  and its holes read at a glance. The hairline may miss 3:1 in dark mode on
  purpose: it repeats what the circles say and carries nothing of its own.
  It spans the WHOLE width it is given and the questions share it equally,
  with no cap: the strip is a map of the paper, and three questions drawn as
  three stubs at the left edge map nothing. Every circle carries its NUMBER
  under it, quiet (`fg-faint`, 11 px) except the current one, which is the
  accent and bold — a student aims at "question 7" instead of counting.
  Roving tabindex like `Tabs`, because twenty questions must not be twenty
  stops on the way to the answer field; the state is in the accessible
  name, not only in the shape.
  Past a certain count the strip COMPRESSES rather than wrapping,
  measured on the strip's own width (a `ResizeObserver`, never
  the viewport: the same strip is 760 px in the player and 358 px on a
  phone). Under 28 px per question the 20 px circles drop to 10 px dots
  without glyph — the shape stays — and the current one becomes a solid
  accent dot with a 3 px halo (its mark is then only in its name). The
  numbers thin out on their own rule: 22 px or more holds two digits and
  its air, so everything is numbered (about 30 questions over 760 px); from
  14 px, the first, the last, the current and every 5th. A multiple landing
  within two slots of the last one is dropped, so "30" and "32" never
  collide. Under 14 px a dot and its connectors no longer fit (40 questions
  on a phone), and the strip SCROLLS instead (issue #223): every question is
  back in a full 28 px slot with its glyph and number, the student swipes
  the strip, and it brings the current question to its middle whenever it
  changes — scrolling itself, never the page, and without the smooth motion
  under `prefers-reduced-motion` (nor on the first load). Its hidden sides
  fade like the Tabs strip's (`useScrollFade`). Nothing is lost: the number and the state
  live in each circle's accessible name, which never thins out.
- ProgressList: the same question list, standing — the zen player's side
  column from 1024 px of viewport up. A laptop has width to spare and height
  to none, so the list and what the current question is worth move out of
  the bar and from over the question into a
  12rem column left of it (sticky, bounded to the viewport). The column is
  PINNED to the left edge of the frame, for every evaluation, and never
  moves from one question to the next (ADR-066): the question is centered
  in the room right of it — a text question in its 760 px, a wide one
  (below) in the whole room. The frame is the screen up to 1872 px and
  centered past it; the bar spans the frame, so the title lines up with the
  list. Same circles, same four facts, same connector
  (drawn down), same accessible names as the strip; each row adds
  "Question n" in words, so nothing thins out and nothing compresses — a
  long paper scrolls inside the list, which keeps the current row in view.
  Roving on ↑/↓ (the rows stand, and stop at the ends), ←/→ stepping with
  wrap as on the strip, Home and End. Under the list, a hairline,
  then the current question's own line — "Question n · p points" — and
  the move keys (`Alt` + ←/→) in `Kbd`. The flag stays in the card's
  corner, "Leave unanswered" and "Clear" under the question: they act on
  the question and its answer, not on the list. One question, or under
  1024 px, the column is absent and the strip is back in the bar.
- Wide question (`QuestionTypeClient.wide`, ADR-066): the one exception to
  the 760 px, for a statement that must stay in sight beside a program —
  `code` and `codeimage`. From 1024 px of viewport its column takes the room
  right of the rail, up to 1600 px (`max-w-400`); without a rail, the body
  takes 1600 px, gutters included as for the 760 px. Inside, the player
  decides by its OWN width (a container query):
  from 60rem the statement (2fr) stands beside the editor and its tools
  (3fr), the cases or the picture across the whole width under them;
  narrower — a 1280 px screen, a 12" Chromebook, a tablet, the teacher's
  sheets — the same tree stacks, so Monaco never remounts. A canvas
  (`circuit`, `diagram`) is not wide: it has Expand.
- Pastille (`packages/qt-mcq/src/ui.tsx`): the letter of a choice IS its
  checkbox — a circle, 32 px in the teacher's editor, 40 px under a student's
  finger. A hairline `line-strong` circle on `surface` with a bold `fg-muted`
  letter at rest, `accent` border on hover of the row, an `accent` fill with
  `on-fill` ink when it is ticked, 0.94 on press, 120 ms and none under
  reduced motion. It is a native input, visually hidden inside the `<label>`
  the caller draws (the pill in the editor, the WHOLE row in the player), so
  the roles, the grouping of the radios and the keyboard are the platform's;
  the disc is `aria-hidden`, because in the player the name of the control is
  the text of the choice and not a letter. It replaced a letter plus a box
  labelled "Correct": two targets and a word that named nothing a teacher was
  looking for.
- LetteredChoice (`packages/qt-mcq/src/ui.tsx`): a choice behind its letter
  in a CORRECTION — the mcq review and the poll's reveal on a phone — where
  nothing is clicked. A 28 px letter in the state of the grading table's tick
  box (`ChoiceMarkState`, one rule, `choiceMark`): the key's filled
  `success`, a wrong tick's filled `danger` on a `danger-soft` row, a tick
  with no key filled `fg-muted`, the rest the pastille at rest. Like the
  correction projection, the key's letter is green; unlike it, an untouched
  distractor stays at rest — the review is one paper, not the room's. A
  filled letter always has its verdict in words beside it.
- VerdictCell: one cell of the live grid and of the grading list, nine
  states in two families. PROGRESS is drawn in SHAPES, not pictograms
  (#227) — `blank` (never opened: a faint 10 px hollow square glyph,
  `line-strong`), `inProgress` (opened, nothing written: the cell itself an
  empty box, a `line-strong` edge and no fill), `answered` (holds an answer:
  the box filled `info-mid`, no icon), `done` (validated in a locking
  navigation: the `info` fill AND a check, because two blues alone would be
  colour alone), `skipped` ("Leave unanswered", issue #89: `surface-2` with a
  DASHED `fg-faint` edge and a dash — a decision to leave the question, not
  progress through it, so not blue) — and VERDICT, which the grid's
  "Results" switch puts in their place: `correct`, `partial`, `wrong`,
  `pending`, each with its icon, since there the icon is the meaning. Shape
  or icon, **and** tint, **and** word, never a tint alone: a dashboard
  projected on a lecture-hall wall loses half its saturation. Its height is
  `--cell-h` (28 px by default): the live grid sets it from the row height
  it computes to fit the class on one screen (`--row-h`, 24 to 36 px). `value` holds
  the answer in a glyph or two ("A, C", "NULL", "12 L") beside the icon (or
  alone in the box), and
  INHERITS the state's ink rather than carrying `fg` — that is what keeps it
  readable on the filled `done` blue, where `fg` measured 2.9:1. `flagged`
  (the student's review flag, issue #89) is a third fact on top of the state,
  so it is a corner mark rather than a tint: a solid `warning` flag on a
  14 px `surface` disc with a `line` ring, top right, and "flagged for
  review" in the accessible name. The column header counts the class's flags
  (a flag and the number, `warning`) on the same line as `Q3`, so the header
  row stays one line tall, level with Student and Actions; the question's
  type is the header's tooltip.
- Master and detail (the grading panel, #102): from `lg`, the step header
  (picker, chevrons, progress) sticks to the top on a strip of `canvas`; its
  measured height is the CSS variable `--grading-sticky`, under which the
  compact list column (300 px, scrolling inside itself) and the detail's own
  header stick. The answer itself stays in the page's flow — a wheel over it
  scrolls the page, never a pane — and is at least a window tall, so that
  opening another answer can always bring its top back right under the
  sticky header: the teacher never scrolls to find it, and reads every answer
  from the same spot, at 768 px of height as at 1080. The list keeps the
  current row in view by scrolling itself (never `scrollIntoView`, which
  scrolls the page too). The current row is the sidebar's: `accent-soft`
  with its name in `accent`. Anything above the answer that could vanish
  keeps its place instead (the batch banner says "nothing left" rather than
  disappearing). Below `lg` the list becomes a `Select` above the answer and
  the same alignment happens under the phone's top bar.
- Master and detail (the pool, browse to choose): a click on a question row
  or card shows the question as a student reads it (`QuestionPreview`, the
  picker's reading pane too, one request and one cache entry) in an in-page
  pane, never a `Sheet` — the list stays live beside it. Look and edit are
  two gestures (`pool/useQuestionBrowse.ts`). A click and P look; ↑/↓/Home/End
  walk the rows in the order they are DRAWN (sections included), stop at the
  last loaded one (`listboxIndex` with `wrap: false`) and, where the pane can
  dock, show the row they reach — opening the pane if it was closed, since
  browsing with the arrows is the point; on a narrow window they only move,
  and P is the keyboard's way in (`aria-keyshortcuts`, and in the shortcut
  strip). Enter, a double-click and the pencil edit, in the same tab; Space
  and the row's star toggle the caller's favourite (F-POOL-10) — an outline
  `IconButton` with `aria-pressed`, filled in `fg` when starred, never in
  accent or warning: a favourite is a personal mark, not the screen's one red
  thing nor a state that needs attention, and a column of amber stars would
  outshout the draft badges; Escape (handled once, on the
  wrapper of list and pane) and the ✕ close and hand the focus back to the
  row. One row is in the Tab order (roving tabindex), the shown one wears
  `aria-current` and the grading panel's `accent-soft` with its name in
  `accent`; a card is a focusable `listitem`, not a button, since its click
  is not its Enter. The pane is a named `aside` whose heading is a polite
  live region: walking the list announces the name, not the body. From
  `ASIDE_MIN_WIDTH` the pane (30 rem, `surface-2`, hairline, `card` radius,
  sticky and scrolling on its own) docks right, and the page widens past the
  shell's cap by exactly the pane and its gap, computed from `PAGE_COLUMN`
  (`ui/page.tsx`, the one source of the cap and gutter the shell uses too).
  The widened page keeps the list's left edge and grows right, moving left
  only by what the window lacks, so a clicked row stays under the pointer on
  a very wide screen; there every column stays, and a narrower one gives
  them up by `T`'s priorities — the table measures its own container. Below
  `ASIDE_MIN_WIDTH` the pane replaces the list with a Back button, as in the
  picker; on that width a click waits 300 ms for a second one (not under a
  coarse pointer, which has no double-click), or the double-click would lose
  its row under the pointer. No empty pane: it appears on the first look,
  and which question it shows is screen state, never the URL. The cards
  count their columns on their own container for the same reason as the
  table.
- SyncBadge: whether the student's work is safe — `saved`, `saving`,
  `offline`, `closed` — icon plus word, in a polite live region, since it is
  the answer to "did that save?". The word hides under `sm` where the zen bar
  has no room, and the accessible name keeps it.
- MarkdownView: the ONE renderer of untrusted content a student sees
  (prompts, choices, explanations, comments). Markdown through marked, then
  an explicit DOMPurify allow-list, then KaTeX last so its own markup never
  has to be allow-listed; `asset:<id>` images resolve to `/app/api/assets/`
  and every other `src` is dropped. Its typography lives in the `.md-body`
  block of `style.css` — the one place a stylesheet is unavoidable, because
  the content is HTML the component never sees as React elements. `size="sm"`
  is the dense variant for a table cell or an inspection panel.
  `markdown.tsx` beside it is a different thing: trusted help text turned into
  React elements, never into HTML.
- RichText: the teacher's editor (decision D11, Tiptap). Markdown in, markdown
  out; the surface renders with the student's own `.md-body`, so the field IS
  the preview. Its toolbar ends with ONE toggle to the markdown source — a
  textarea with the caret-level toolbar of `insert.ts`, `Ctrl+B` / `Ctrl+I`,
  Tab as two spaces — because "Write / Source" as two named panes was the one
  thing a teacher did not understand. An image pasted, dropped or picked goes
  through `uploadImage` and comes back as `![](asset:<id>)`, and a drop lands
  where it was dropped, not at the caret. `toolbar="focus"` folds the toolbar
  INSIDE the field and shows it while the field has the caret: that is what a
  row of a list (an mcq choice) wears, since six permanent toolbars are a wall
  of icons. A block field is 128 px high, sized for a prompt; `rows` asks for
  more, in lines of its text, as a textarea's does — the essay's answer field
  takes 12. MarkdownField around it is a label and the upload adapter — no
  hint line: it named the keys the toolbar above it already shows, on every
  field of a four-field screen.
  An IMAGE in the editor carries its own bar, at its top-right corner while
  the pointer is on it or it is the selection: rotate left, rotate right,
  size, delete. It is the one pill allowed a shadow next to the page flow,
  because it genuinely floats over the picture. Rotation happens in the
  browser (canvas) and is uploaded as a NEW asset, so nothing but
  `asset:<id>` ever reaches the markdown; the SIZE is a percentage of the
  column carried as a query on the reference — `![alt](asset:<id>?w=50)` —
  which `render.ts` turns into an `md-img-50` class for the student (a class,
  never a `style`: the sanitiser admits one and refuses the other). An inline
  field answers `Ctrl+Enter` with a NEW PARAGRAPH, so a choice can hold a
  second line or a fenced block; plain Enter still belongs to the list around
  it.
  A FENCE is written as markdown is written, in either field: a line that is
  nothing but ``` or ```c becomes a code block on Enter, Ctrl+Enter or
  Shift+Enter, and a closing ``` gathers the paragraphs above it into one
  block the moment its third backtick lands — which is what rescues the lines
  a teacher already typed. Inside the block the keys mean code, and the
  shortcut strip says so while the caret is there: Enter is a new line,
  `Ctrl+Enter` leaves the block, Tab indents by two spaces. The block carries
  its LANGUAGE in a small field at its top-right corner — the same placement
  as the picture's toolbar, for the same reason — because the tag of the fence
  is what colours the code and what the student's `render.ts` reads, and it
  was the one thing the block could not say. The colour is the STUDENT's
  tokenizer (`markdown/highlight.ts`, four classes), drawn over the document
  as ProseMirror decorations: the same four token colours the reader gets,
  and not one character of it in the markdown.
  A TABLE is a GFM table in the markdown and a real table in the field: the
  toolbar inserts a 3 × 3 one, and while the caret is inside it a menu — not
  seven more icons in the strip — adds and removes rows and columns. It wears
  the student's own `.md-body` hairlines; the editor adds only what an editing
  surface needs, a cell you can still aim at when it is empty and an
  `accent-soft` tint on a selected run of cells.
  A `{{…}}` HOLE of the cloze type is an OBJECT in the field and not five
  characters: a pill in `accent-soft` on `accent`, 13 px mono, showing the body
  as written with a `▾` in front of a dropdown. Clicking it opens the same
  one-field bar the link address uses; Backspace takes it whole. It is what let
  the cloze editor drop its textarea, since a hole written as text came back
  with the serializer's escapes in it. Inside a fenced block a hole stays text
  — a code block holds no nodes — and is tinted by the same decoration plugin
  as the keywords, through a fifth token class, `tok-hole`.
- FormulaDialog: the one surface a formula is written on. A LaTeX box (which
  takes the focus — experts type), a MathLive `<math-field>` with its symbol
  palette (novices point), a live KaTeX preview of what the student will see,
  and Inline / Display. It opens from the Σ button, from a click on a formula
  already in the text, and by itself when `$$` on an empty line makes an empty
  one. MathLive is loaded on first open and dressed in the tokens through
  `markdown/formula.css`; its fonts are the KaTeX fonts the page already has.

## The question-type surfaces (`@quiz/ui`)

The editors, players and reviews of the question types live in `qt-*`
packages, which cannot import `apps/web`. What they share with the app is
therefore written in `packages/ui/src/styles.ts` and read by both sides, never
copied: `cx`, `inputClass` / `inputSize` / `textareaClass`, the field
label, `buttonClass` and `Segmented`. The rest of that file is the vocabulary
of the question surfaces, one token per role and never two dialects of it:

| Token | Value | Role |
| --- | --- | --- |
| `label` | 13 px, 500, `fg`, a row | the label of a field, the caption of a group of fields (the app's `FieldLabel` row) |
| `hint` | 13 px, `fg-muted` | the sentence that explains a control or a section of an editor (the app's `SettingRow` description) |
| `caption` | 12 px, `fg-faint` | a quiet aside that only supports its surroundings: the instruction under a player's question, "no answer" in a review, the note beside a field in a dense row |
| `reviewPrompt` | 14 px (13 px through the app's renderer), 500, `fg` | the statement at the head of every review, set apart from the answer under it by its weight; not a cloze's text, which IS its answer |
| `sectionTitle` | 16 px, 700, tight | the title of a card or section (the app's `SectionHeading`) |
| `sectionClass` | column, 8 px | a section of an editor laid out as a plain form |
| `card` | `surface`, hairline, card radius | the cards of the code and circuit editors (`EditorSection`) |

Two layouts use these tokens, on purpose. The mcq, short and cloze editors
are short PLAIN FORMS — a few `sectionClass` sections, a `label` over each —
and the code and circuit editors, whose sections are many and long, are
CARDS (`EditorSection`, `PromptSection`, `AdvancedDisclosure`). The tokens
inside are the same; the layout is the editor's.

Likewise, a review states its score in one of two places. The mcq, short and
cloze reviews end with `ScoreHeader`, a quiet line under an answer that is a
line or two long; the code and circuit reviews open with it as a
`sectionTitle`, runner badges beside it, over a long review. Both go
through `pointsOrDash`: an answer nobody graded reads `—`, never `0`.

## Projection (the poll on a beamer)

One screen of the product is not read at arm's length, and it is the only
place where this file's scale does not apply: `PollProjection` is thrown on a
lecture-hall wall and read from thirty rows back. Six extensions, and
nothing else on it leaves the system.

- **A scale of its own, in `clamp()`.** The question is
  `clamp(30px, 4.6vw, 68px)` at 700 and `-0.03em`, a choice
  `clamp(19px, 2.3vw, 36px)`, its percentage `clamp(20px, 2.4vw, 38px)` in
  mono, the session code `clamp(34px, 4.2vw, 64px)`; the context strip and
  the counts stay at reading size. It is the same 2× jump the rest of the
  product uses, multiplied by the room: the viewport IS the projector, so the
  sizes are measured against it rather than picked from the 12–28 px scale.
  Nothing else in `apps/web` may use a `clamp()` type size, except the
  correction projection below, which is the same wall, and the kiosk
  station, read from two metres (below).
  The question's own step is picked from its LENGTH (`questionScale`): a
  one-line question gets the full 68 px, and two longer steps follow, because
  a four-line question at 68 px pushes the last bars off the wall — and
  nothing on this screen may be truncated, since a question is read, not
  summarised. From `sm` up the stage IS the viewport (`h-dvh`, no page
  scroll): the session code and the QR stay on the wall whatever the question
  costs, and only the middle band gives way. The distribution shows at most
  eight rows and counts the rest in one muted line: a free-text tally carries
  up to sixty distinct spellings, and sixty bars is a wall of noise.
- **The bars are `info`, never the accent.** A distribution is data, not an
  action, and HEIG red on a wall reads as "wrong" from the back row while
  nobody is being marked. The calm blue carries no verdict (green, amber and
  red are taken, as on the live grid), and at the reveal it still parts
  clearly from the correct row's `success` and the faded rows' `surface-3`.
  The participant's reveal (`PollJoinReveal`) draws its bars in the same blue.
- **Six choices or more go in TWO columns**, column-major, so A–D are the left
  column and E–H the right one and the letters still read downwards
  (`lg:grid lg:grid-flow-col` over `repeat(⌈n/2⌉, auto)` rows, with
  `grid-auto-columns: minmax(0, 1fr)` — a bare `1fr` floors a column at its
  min-content width and pushes the grid off the wall). Eight bars in one
  column is a list so tall that the fit below has to shrink the whole wall to
  a third to hold it, and the room then reads none of it. Below `lg` the
  window is not a wall and the single column stays.
- **The middle band gives way by SHRINKING, never by scrolling.** The length
  of the prompt is not the whole story — eight choices of two lines clear a
  1280 × 720 projector under a one-line question — so what the band cannot fit
  it draws smaller: `useStageFit` measures the block against the room the
  header and the footer left it and applies one `transform: scale(k)` with
  `transform-origin: top center`, `k ≤ 1` (`fitScale`, `src/poll/fit.ts`,
  recomputed on resize, full screen, question and reveal). It is a transform
  and not a root font size because every size here is a `clamp()` of `vw`/`vh`
  units and a root font size would move none of them; one transform moves the
  question, the bars and the percentages together, in the ratios picked above.
  It never magnifies: a question that fits is drawn exactly as designed. The
  band hides its overflow, so no scrollbar can ever appear on a wall.
- **The block is WIDENED before it is scaled.** Scaling a block laid out at
  the width of the band shrinks it away from both side edges: the wall ends up
  two thirds empty and the text half the size the room can read. So the fit is
  a short search — `layoutWidthFor()` gives the widest layout a candidate
  scale may use without spilling sideways (`availW / k`, capped at four times
  the band), the browser measures what that layout costs in height, and the
  largest candidate whose measured height still fits is the one applied. Four
  measurements, each verified rather than predicted (a block's height steps
  down each time a label stops wrapping, so nothing can be extrapolated), and
  the first candidate is the un-widened fit, which cannot fail — the search's
  worst case is a plain scale. On the 8-choice question of the mock that is
  `k ≈ 0.60` and 18 px of choice text at 1280 × 720, and `k ≈ 0.74` and 27 px
  at 1920 × 1080, against 11 px and 16 px for the same fit without widening.
- **The way in is TOP right, and it is the only thing in that corner.** The
  host, the session code and the QR tile travel together, in the first band of
  the stage (the original design had them in the footer; the product does not). The
  reason is the toaster: `notify.tsx` pins the toast stack to `fixed bottom-4
  right-4`, and a "student joined" notice arriving mid-lecture landed straight
  on the code the back rows were scanning. The two corners are opposite ones
  and neither has to know about the other. The teacher's controls stay in the
  same top strip, pushed against the tile — the room's eye is on the question,
  not up there.
- **The QR tile does not follow the theme.** White background, `#131211`
  modules, in light and in dark alike, because a camera needs the contrast the
  code was designed with and an inverted QR is one half the phones in the room
  will not read. It is the only element of the product allowed a fixed colour
  pair, and it is a hairline-bordered tile so it still reads as a surface.
- **Dark by default, and only here.** The screen turns `html.dark` on when it
  mounts unless this browser has explicitly stored `light`, and puts the
  theme back when it leaves — without persisting anything: a beamer throws
  light, so a white page is the room's lighting. The toggle in its control
  strip writes a real choice, like every other theme toggle.

The rest is the system as written: the bar track is `surface-2`, the fill is
`accent-soft` on an `accent` hairline, the revealed key is `success` with a
tick AND the word "Correct answer" (never a tint alone — a projector eats half
the saturation), and the rows that are not the key FADE to `fg-faint` rather
than turning red. Nobody in the room is being marked wrong.

Votes hidden, a row keeps the PLACE of its count, its percentage and its bar
track, empty and `invisible`: showing the votes fills the rows in without
moving them apart or re-wrapping a label.

**The donut (an ended mcq, Space).** Once the vote is over and the votes are
shown, the chart button of the control strip (or Space) swaps the bars for one
large ring beside its legend (`poll/PollDonut.tsx`). It is the wall's own
choice — local state, never sent to the phones — and it is not offered while
the room votes: a pie growing live is a race to the biggest slice. The ring is
`clamp(240px, 42vh, 520px)`, 22 % thick, with the total of the votes in the
hole in the mono figure style.

- **Colour is categorical, by choice, in the served order** — never by rank,
  so a choice keeps its colour: `--chart-1` to `--chart-8` in `style.css`,
  the dataviz reference palette (blue, orange, aqua, yellow, magenta, green,
  violet, red), a light and a dark step each, validated against `canvas` in
  both themes. Past eight choices the rest share `fg-faint`. This is the only
  categorical palette of the product; the `pool-*` hues are tuned for text
  and are too light for a filled mark on the dark surface.
- **Never colour alone.** A choice nobody picked draws no slice, so ANY two
  slots may meet on the ring, and with all pairs in play no eight-hue palette
  clears the colour-blind floor (at seven slices, violet next to blue in
  dark is the measured worst case). So: a 2 px surface gap between slices,
  each slice carries its letter on a `surface` chip (from 5 % up), and the
  legend spells every choice and its percentage.
- **Revealed**, the slices outside the key fade to a quarter and the key's
  legend line turns `success` with a tick, as on the bars.

**The bubble cloud (a brainstorm, ADR-071).** A brainstorm's votes are a cloud
of bubbles (`poll/BubbleCloud.tsx`), packed by `d3-force` in a band of
`min(58vh, 760px)`. A bubble's AREA is its share of the participants, and
together the bubbles cover about 40 % of the band. Each bubble is categorical
by idea — `--chart-1…8`, picked from the idea's key so it keeps its colour —
drawn as a 2 px ring of that colour over a 22 % tint of it, with the label in
`fg` and the count under it in mono. The label is always inside, so the colour
never carries meaning alone. Its size is the largest that fits the inscribed
square and keeps the longest word on one line. The ideas awaiting moderation
are counted on the "Moderate" button in `warning`, not in the accent, which
stays the Live pulse's and End's. The moderation board is NOT on the wall: it
opens in another tab, because a queue of raw text is what the wall must never
show.

## Tables

At most seven visible columns, one dominant identity column, numbers right
aligned and tabular, status as a `Badge`, actions last, `—` for an empty
cell. All of it lives in `T` in `ui/table.tsx`.

Seven columns do not fit every width, and the width that matters is the
TABLE's, never the viewport's: the same pool table is 1120 px wide on a
1440 px screen, 720 px beside the sidebar on a 1024 px one and 704 px on a
768 px tablet with no sidebar at all — the viewport told us nothing in two of
those three. So the wrapper that scrolls the table carries `T.container`
(`@container`) and the columns carry a PRIORITY, measured against it:

| Class | Shown while the container is | Goes |
| --- | --- | --- |
| `T.colLow` | ≥ 64rem (1024 px) | first |
| `T.colMid` | ≥ 56rem (896 px) | second |
| `T.colHigh` | ≥ 42rem (672 px) | last |
| `T.wordFrom` | ≥ 32rem (512 px) | gives a badge its word back |

The thresholds are measured, not picked: 1120 px of content keeps everything,
the pool table started clipping its actions at about 800 px, and 672 px is
what the tablet width leaves. The identity column, the tick box and the
ACTIONS never carry a priority — they are the row and what you do with it.

Below the last threshold the table still scrolls sideways. The actions cell
then takes `T.stickyEnd` (`sticky right-0` on the row's own fill, hover
included), because a row whose actions are off screen is a row you cannot
act on, and that was the bug the priorities were added for.

Every table sorts by its column labels, through one motif. A head is
declared as DATA — one `Column` per column, carrying its label, its
priority class and its width — and `TableHead` (`ui/table.tsx`) draws it, so
the head and the priorities can no longer disagree and every table of the
app sorts the same way: click a label to order by it, click it again to flip
it. The affordance is the arrow, and it stays inside the hairline aesthetic:
a faint `ArrowUpDown` that fades in on hover and on keyboard focus, in the
DOM the whole time so nothing shifts when it appears, and the solid
`ArrowUp` / `ArrowDown` in `fg` on the column that is sorted — which also
carries `aria-sort`, the same answer for a reader who cannot see the arrow.
On a right-aligned column the arrow hangs to the LEFT of the label, so the
word stays flush with the figures under it.

`useSortableTable` takes a `null` initial sort, and `null` is not "sorted by
the first column": it is the order the rows arrived in, kept until the
reader asks for another one. The evaluations of a classroom come ordered the
way that classroom works through them and the versions of a question come
newest first; reshuffling either on mount throws away an answer nobody
clicked for. The tick box, the actions column and a column of prose take
`sortable: false` — they never sort, and the actions label stays `sr-only`.

A row with a `colSpan` needs care: a cell spanning a column the container has
hidden leaves that row one column wider than every other one, and the table
shears. An inline edit row gets one cell per column, empty ones included.

Applied today: the pool table (version, updated, tags), the roster (last
sign-in, accommodation, e-mail), the evaluation list (attempts, points,
questions) and the grade table (duration, e-mail).

A table a STUDENT reads on a phone does not scroll sideways: under 32 rem of
container (`@lg`) its rows collapse into a divided list of small cards — the
identity bold with kind and date under it, the figure that matters (the
grade) on the right, the status badge below — and the `<table>` is hidden.
Same rows, same order, same "opens on press". Applied today: the student's
Grades (`student/StudentGrades.tsx`).

### When a row stops being a row

Past seven columns there is no priority left to give: the record is not a row
any more, it is a small form. Then it gets a PANEL — `rounded-card border
border-line bg-surface-2`, a heading that names it ("Case 1"), and its fields
laid out in two or three short lines that stack at 390 px.

Applied today: the test cases of a `code` question
(`packages/qt-code/src/Editor.tsx`). One case carries a name, a command line,
an input, an expected output, the two checks that decide whether it passed,
its points, its time budget and its visibility — ten fields. As a table it was
unreadable at 1440 px; as a panel it reads at 390 px.

The threshold is not the count, it is the question "would a teacher SCAN these
or EDIT them?". A list you scan stays a table however many columns it has to
drop. A list you edit field by field becomes panels as soon as a row needs
more than one line.

## The grading table (ADR-044)

One question's answers as a table (`src/grading/`, origin
`mockups/grading.html`). What is particular to it:

- **Widths.** The answer columns share the width equally (a `<colgroup>`
  of `100% / n`); the verdict, the student, the points and the actions are
  `w-px whitespace-nowrap`. A wide empty last column is the one layout this
  table must never show. Past the page's width it scrolls sideways under
  its sticky verdict (and student) column; every `<td>` carries its own fill
  so a sticky cell never lets the scrolled ones show through.
- **Verdict glyph.** A 22 px `rounded-md` square: correct = solid `success`
  and an `on-fill` check; partial = HATCHED, `success` stripes over
  `success` at 40 % on `surface` (`color-mix`), a small solid check square
  inside — "some of it" before the eye reaches the check; wrong = solid
  `danger` and a cross; not judged = a dashed `fg-faint` outline and "?",
  its reason in the tooltip. The expected row's mark is a star on `info`.
  It is NOT the live grid's `VerdictCell` (`ui/live.tsx`), on purpose: that
  cell is a tinted tile of a grid where partial reads AMBER beside the blue
  of progress, one of nine states; here there is no progress to tell apart,
  and the owner wanted partial credit to read as green in part — so the
  stripes. The grid keeps its scale, the table its own.
- **The key's row** is `info-soft` (laid as a flat gradient over `surface`,
  so it stays opaque in dark mode where `info-soft` is translucent), with a
  2 px `line-strong` rule under it. `info` because the key is "a set of
  possibilities", never a verdict.
- **Cells** come from the question type (`@quiz/ui` `AnswerChip`,
  `ChoiceMark`, `NoAnswer`): a mono chip on `success-soft` / `danger-soft`,
  the key in `info` without a fill; a 16 px tick box filled `success` or
  `danger`, dashed `success` for a correct choice left out.
- **Counts and words.** A chip counting parts ("3/4 tests", "5/9 right",
  "2/2 stimuli") and a chip naming a column are in the text face
  (`WordChip`); mono is for what the student typed. A run's state is read
  once, by `runStatus` (`@quiz/ui`): "runner…" while a verdict may still
  come, a red "Not run" when it will not, nothing on a teacher's override.
  An empty cell is `Dash` (a faint em dash). A count (`countTone`) that is
  only partly right is `partial`: `success` text, a dashed
  `success` outline and no fill — the "missed" mark's convention, green in
  part. A cell that must not ask its column for width (a column per card)
  wraps its chip in `block w-0 min-w-full`, so the equal shares hold.
- **Clamped code box** (`ClampedCode`, `@quiz/ui`, for `code` and
  `codeimage`): mono 12 px / 1.45 on `surface-2`, `rounded-field`,
  `w-full` — the WHOLE column, never fit to the longest line. Past five
  lines (two past: one more line is shown, not hidden) it is clamped to
  five whole lines plus a foot: "⋯ N more lines" in 11 px `fg-muted` over a
  `surface-2` fade. It is then a button (`aria-expanded`, Enter / Space,
  `cursor-zoom-in` / `-out`): a click unfolds it in place and stops there,
  never opening the panel. The key's box writes in `info`. A chip (tests,
  "runner…") or a 56 px thumbnail sits before it in a fixed 96 px lead, so
  the programs of every row start at one line. A thumbnail is drawn only
  once its row nears the viewport.
- **An essay** is plain text clamped to three lines (`line-clamp-3`,
  13 px, `fg-muted`, at most 110ch), the key's in `info`.
- **No fill for a row waiting for a decision** (owner decision): its glyph
  and its visible action say it — Validate for a proposal the batch would
  take, **Grade** for a 0-point placeholder (an essay), which opens the
  panel on the adjustment form and is never validated unread (nor by V). The selected row is `surface-2` with a
  3 px inset bar on its left (`fg`; `info` on the key's row). Adjust stays
  invisible on a validated row until hover, focus or selection — hidden,
  not removed, so the column keeps its width.
- **The key's actions.** Edit question (only for whoever may write the
  pool) and Re-grade are `IconButton`s. While a newer version of the
  question is published, Re-grade becomes a `secondary` `sm` Button — icon
  and "New version", no number — with "A newer version is published —
  re-grade" as its tooltip and name: a filled secondary, never the accent,
  which stays Validate N.
- **A parameterized question** (ADR-056 §9): the key's row is the question
  as written, its `[[…]]` left in the type's own key chips (mono, `info`),
  or an italic `fg-muted` "per answer" in each cell when only an example
  could be drawn; a `zinc` badge with the dice icon, "Own key per answer",
  stands before the key's actions and explains itself in its tooltip. The
  rows stand sorted by verdict (the Verdict header shows it). The panel adds the student's values as
  `surface-2` mono chips, `name = value`, under the review, and the key's
  panel the variables, one mono line each, the format worded in the text
  face. On the correction projection, "Example values" sits above the
  statement in the caption size with the dice icon, and a parameterized
  short or cloze draws no answer groups: the head's bar holds the verdicts.
- **The answer panel** is a `Sheet` with two optional slots added for it:
  `leading` (the verdict glyph before the title) and `actions` (↑ / ↓
  before the close button).

## The gradebook (ADR-074, M5-04)

The classroom's Grades tab (`src/gradebook/`). The teacher's is a MATRIX, not
a table in the sense of the rules above: a row per claimed student, a column
per exam, exercise or graded project, so the seven-column limit and the
priority classes do not apply — the number of columns is the classroom's.
What replaces them:

- **Scroll.** The card is the scroller (`overflow-x-auto`) and is `relative`:
  the cells' `sr-only` spans are absolute, and a scroller that is not
  positioned lets them lay out past its edge, on the PAGE (it scrolled
  sideways at 390 px until this was found). The student column is sticky on
  the left on its own fill; the mean is sticky on the right from `@2xl`
  (42 rem of card) and scrolls with the rest below it. On a phone the e-mail
  under the name goes, so the first grade column stays on screen.
- **Head.** A column's title (13 px semibold, truncated) with its kind and
  weight under it in 11 px muted — "Exam · 40 %", the weight a whole
  percentage ("Not counted" when it is left out of the mean), and the menu of its settings behind a faint chevron: whether it
  counts, its weight. A column NOT released carries a `zinc` badge with the
  eye-off icon and a `surface-2` strip over its whole height; its cells show
  no grade of the activity (a mark of the teacher's stands there) and the
  column is out of the mean.
- **Cell.** The grade as `Grade` writes it, centred, tabular. A cell is a
  `Menu` trigger — absent, a score, clear the mark — except on an archived
  classroom, where it is plain text. A pencil beside a grade says "set by
  the teacher"; an amber triangle says "changed since the release".
- **The absence `a1.0`.** A 22 px `rounded-md` chip, mono 12 px semibold, in
  `info` over `info-soft` — a colour of its own. A real 1.0 is a grade, in
  `danger`; the absence is an administrative status that counts as 1.0, and
  the two must never read alike, so the sigil borrows none of the verdict
  colours (green, amber and red all mean a verdict, as on the live grid).
  The text is the notation of the school and of the CSV, the same in every
  language; the tooltip and the screen reader say what it stands for.
- **Class means.** A `<tfoot>` row on `surface-2` (the student's mean row's
  fill), "Class mean" in the sticky student column with a tooltip saying
  what it is: each column's class mean, centred and semibold like a grade,
  a dash for a column not released, and the overall class mean under the
  mean, pinned with it from `@2xl`. Staff only.
- **Primary.** Export CSV, in the page header (`variant="primary"`), a plain
  download link. The switch "Students see their mean" is a `SettingRow`
  above the matrix, never an accent; every other action is a menu or a
  dialog (a score has three fields, a weight one).
- **The student's** is a list in one card, hairline rows, the same at every
  width: the activity bold, kind · date · weight under it, the value on the
  right in 17 px semibold — a grade, `a1.0`, a dash, "indicative" under its
  points, or "grade not shared". The mean is the last row on `surface-2`,
  present only when the payload carries it.

## Poll outcome donut (launcher, "Recent polls")

A 36 px ring beside each row of the launcher's "Recent polls" (issue #161,
`poll/OutcomeDonut.tsx`): how the question fared over its last five runs.
With the projection's donut, one of the two charts of the teacher's
surfaces, so its rules are written here.

- **Three parts, fixed order**, clockwise from twelve o'clock: correct,
  incorrect, no answer. The order never follows the size of a share.
- **Colours**: correct `success`; incorrect `warning`, NOT `danger`; no
  answer `fg-faint` at 50 %. Red against green was measured with the dataviz
  validator: ΔE 6.7 (deutan) in light and 4.0 in dark — below the floor even
  with secondary encoding; `success`/`warning` is 7.1 / 7.6, legal with it.
  It is also the voice of the projection: a poll marks nobody wrong. No
  answer is an absence, not a category, hence a grey; `line-strong` vanished
  on the dark surface.
- **Never colour alone**: 2 px surface gaps between the parts, the correct
  share printed in the hole (10 px, tabular), the exact shares in words on
  hover AND focus (`Tip`; the ring is focusable, `role="img"`, and its
  accessible name is the same sentence), and one legend line above the list
  naming the colours ("no answer" only when some ring has it).
- **An opinion poll has no ring**: no key, nothing to be right about — the
  row says "n answers" in `fg-muted`. A question with no finished run shows
  nothing.
- The ring sits BESIDE the pressable part of the row, not inside it: a
  focusable thing nested in a button is one control too many.

## The pool's tag heat (Tags tab, "Heat")

A squarified treemap of the pool's tags (`pool/TagsTab.tsx`, layout in
`pool/treemap.ts`): one cell per tag a question wears, its AREA the tag's
share of the summed question counts. The area is the whole message, so the
chart has no colour yet: every cell is `surface` (`surface-2` on hover) and
the hairlines between them are the box's `line` fill showing through a 1 px
gap — the hairline language of a table, not a border per cell, which would
draw them 2 px where two cells meet.

- **The box**: the page's width, 288 px tall on a phone and 416 px from
  `sm`, `rounded-card` with a `line` border. It is measured, so the layout
  runs on its real aspect and a square cell stays square.
- **A cell is a button**: `#tag` at 13 px / 600 over the count in `fg-muted`
  at 12 px, both truncated; under 44 × 40 px only the count is drawn. Its
  accessible name and `title` carry the tag and both counts in words. The
  box clips, so the focus ring is drawn INSIDE the cell (`-2px` offset)
  instead of the usual 2 px outside, which an edge cell would lose.
- **A tag no question wears has no area**: it is in the table, never in the
  heat; a caption under the box says so.

## Correction projection (the graded evaluation on a beamer)

`/evaluations/:id/correction` (`results/CorrectionProjection.tsx`, ADR-033):
the Results "Questions" tab on the wall. It takes the projection's
`clamp()` scale and its dark-by-default theme.

- **One screen per question**, snapped, under a 64 px sticky strip: the way
  back, the title, a stepper of question numbers only, the controls. The one
  primary action is "Reveal the answers" (R).
- **Head**: "Question n · type · points" (never the internal name), a 10 px
  bar of the class with its legend (the same list of parts), and the success
  rate in large mono with a half-size `%`, "out of n papers" under it.
- **Thin bars are the one reading** (`SegmentedBar`, `ui/bar.tsx`): 8 px per
  choice or test case, 6 px under a cloze blank. A choice's bar is the share
  of the papers that ticked it and a test case's its passes, each with its
  figure at the right (tabular, like a short answer's row, whose count is the
  row's content). Every bar also speaks in the hover and focus bubble and its
  accessible name, one sentence built from the parts ("wrong: 4 · no
  answer: 1", "correct answer · ticked: 13"), so colour is never its only
  reading.
- **Colours**: full credit `success`, partial `success` hatched over the
  track, wrong `danger`, no answer `warning`. Red, unlike the poll donut,
  because a graded paper marks answers wrong (ADR-033); colour is never
  alone — 2 px gaps, texture for partial, a fixed order, the figures in words.
  A choice's bar is ONE part: `success` on a key, `danger` on a distractor,
  the rest the track; a blank's is right `success` and wrong `danger` over
  the track, an empty blank being the track too. Amber, the absence, is never
  a part of either — a choice nobody ticked is not a choice left blank.
- **The key is not framed**: a key's letter is filled `success` / `on-fill`, a
  distractor's is `danger-soft` / `danger` with its text in `fg-muted`.
- **Hidden first**: a choice's bar keeps its length in `muted` and says
  "ticked" only (how the room voted, which the ticks alone do not tell the
  key from), its letter stays neutral; a blank keeps its width without ink
  over one muted length, the share that filled it in — the right / wrong
  split IS the key; the reference solution is hatched `surface-2` /
  `surface-3`. R reveals; E adds the explanation, only where there is one.
- **The same pieces on the page**: the Results "Questions" tab draws them
  with the `page` density, always revealed. The sizes of both densities are
  one table, `SCALE` in `results/CorrectionQuestion.tsx`. An mcq, a cloze and
  a short answer are drawn whole; any other type keeps its own review for the
  statement and gets the answer groups and the program below it. "Present",
  in the Results header beside "Grading panel", opens this screen once the
  evaluation is over.
- **An exercise's correction, published while it runs** (ADR-050): a
  tertiary action, so it sits in the live header's overflow (`Actions` with
  `menu`, one item whichever state, so the header keeps its shape) —
  "Publish the correction" before, "Present the correction" after, with a
  zinc badge beside the state saying it is published. Its confirmation is
  the plain `useConfirm` dialog, not `danger`: it is irreversible but
  destroys nothing; the last line says so. The projection's header adds, in
  13 px muted, "Handed in so far: n" while the exercise is open — worded apart from a question's "out of n papers", which counts graded answers only.

## Voice

Sentence case everywhere. Buttons start with a verb ("Create question",
"Publish"). Status words are lowercase in badges. Every surface, teacher and
student alike, goes through `t()` with an `en` and an `fr` entry (N-I18N-01).

## The student's bottom bar (phone)

A student opens the app on a phone far more often than a teacher does, and
reaches for it with a thumb (#191, the product owner's decision of
2026-09-29). So under `lg` — the frame's own breakpoint, where the sidebar
gives way to the top bar; between `lg` and `xl` the sidebar only folds to
its icons — the STUDENT UI gets a bar
at the bottom (`student/BottomNav.tsx`, rules in `student/bottomNavSlots.ts`).

- **Student UI only.** A student, or a teacher in student view, who is looking
  at exactly what a student gets. The teacher UI is desktop first and keeps its
  top bar and drawer on a phone.
- **Navigation, never an action.** No slot wears the accent fill; the current
  one is the sidebar's selection (an `accent` icon on an `accent-soft`
  pill), so the screen's one primary button is still the one
  red FILL on it (invariant 2).
- **Slots**, each an icon alone (24 px; the label is for a screen reader,
  `sr-only`, the product owner's decision of 2026-10-01: four or five icons
  a student meets every day need no caption, and the captions made the bar
  heavy), sharing the width equally: Activities (the home, "Open now"), Courses (the student's
  classrooms, `/courses`, and lit on a classroom's pages — F-ORG-14, D07),
  Grades (the student's finished work, `/grades`, and lit on a feedback
  page), Profile (the settings), and Drill (#317, `/drill`) in the MIDDLE.
  Every slot is a route: the last anchor of the home (Grades, `/#past`)
  became the Grades page on 2026-10-01, and the home lost its Past section
  to it.
- **Drill is drawn only when it leads somewhere**: for a student with at
  least one classroom whose drill is on (`visibleSlots`); the four others
  share the width otherwise. Its label is the page's title, `nav.drill`, in
  the bar and the sidebar alike: the feature is "Révisions" everywhere in
  French (the product owner's decision of 2026-10-01); in the bar it is
  what a screen reader announces.
- **The desktop sidebar mirrors the bar** (D07, the product owner's decision
  of 2026-10-01). The student's sidebar rows are the bar's slots, in the
  bar's order and under the same conditions, minus Profile, which is the
  account menu's at the foot of the sidebar: Activities, Courses, Drill,
  Grades (`sidebarSlots`). They take the slots' icons, lead where the slots
  lead, and the lit row is the bar's (the route's `bottomSlot`), not a
  sidebar section: those stay the teacher's.
- **The badge is a dot, never a count.** "Today's drill is available"
  (ADR-041 §6) is an 8 px `accent` dot on the icon's top right, ringed in
  `canvas` so it reads on the lit pill too, with the words for a screen
  reader. The sidebar row carries the same dot as its trailing mark. A
  number of cards left would be a streak by another name, which the product
  owner ruled out; the accent is right because the dot points at the one
  thing to do there, like the primary it leads to.
- **Shape.** It floats, the way a phone's own apps draw it now (2026-10-01):
  a 56 px `rounded-full` pill, 16 px in from the sides (at most `max-w-sm`),
  lifted off the bottom edge by `--bottom-nav-gap` — 12 px, or the iOS
  home-indicator inset less 8 px when that is larger, so the pill tucks into
  the inset rather than stacking on it. `surface` at 85 % with a blur, a
  hairline all round and the popover shadow: it is a floating layer, not page
  flow. The lit slot is a 44 px `accent-soft` pill under an `accent` icon
  drawn a little heavier. `--bottom-nav-h` is the whole band it covers
  (pill, gap and 8 px of air) while it is in the page (pure CSS,
  `:root:has(nav[data-bottom-dock])` under `lg`; zero otherwise): a spacer
  under the page and the toast stack
  read it, so neither the end of a page nor a toast is ever behind the bar.
  An anchor (a journal heading) lands under the sticky top bar through one
  `scroll-padding-top` on the root, from `--topbar-h`.
- **Where it is drawn: an allowlist**, the views the route table gives a
  `bottomSlot` (`router.ts`: the home, the Grades page, a feedback page, the settings, the
  drill, the Courses and a classroom's pages) and nothing else. Hidden on the
  attempt (lobby and player), the poll join page, every projection and
  preview, a SEB-confined page, and any screen with a sticky bottom bar of its
  own (the player's, PollJoin's "Send", the launch step's dock): two bars at
  the bottom fight for the thumb, and the one that is the screen's action must
  win. A new student page does not get the bar until its route has a slot.
- **No repeats.** Where the bar shows, the top bar loses the drawer's trigger
  (the drawer held the home, which the bar and the wordmark both reach) and
  the avatar menu loses Settings (the Profile slot). The avatar stays, for
  what is about the person: the inbox, the theme, signing out.
- A `<nav>` named "Main navigation", `aria-current="page"` on the lit slot,
  real links (a long press or a modified click opens the address).

## The student's "Coming up", by day

The home and a classroom's page group their Coming up section by the day
each card opens (product owner, 2026-10-01; `UpcomingByDay` in
`student/cards.tsx`, the rule `groupByDay` of `@quiz/domain`): Today,
Tomorrow, This week, Later, an empty day not drawn. The day is a
sub-heading INSIDE the section, never a second `SectionHeading`: an `h3` at
14 px semibold, `fg` for Today and `fg-muted` for the others — the teacher
schedule's week heading (`activities/views.tsx`), where this week is the
one in `fg`. 8 px from the heading to its cards, 12 between the cards as
everywhere on the page, 20 between two days, 32 between sections. The cards
are the activity cards below and carry no button, so the accent rule of
the page (`mostUrgent`, one red fill) is untouched; their kind is an icon
and a project's status badge is not drawn until it starts. No calendar or week grid until
the projects bring deadlines (D07).

## The student's activity card

One grammar for every card of the student's home and classroom page — an
evaluation, a poll, a project, a group set, the drill (merge task M3-14l,
product owner 2026-10-06; `ActivityRow` in `student/ActivityRow.tsx`):

- A **kind icon** (lucide, `size-4`, `fg-faint`) before the title: exam
  `FileCheck2`, exercise `PencilLine`, poll `ChartNoAxesColumn`, project
  `FolderGit2`, groups `Users`, drill `Repeat`. It replaces the old kind
  badge. It is an `IconTip`: named by a `Tip` on hover and by its accessible
  name (`role="img"`), so the kind word stays in the card's accessible text.
- The **title** (17 px bold; a link for a project and a group set) and the
  **status badge** beside it, wrapping under it on a phone. Tones: amber when
  a step waits on the student (to accept, open, no group yet, a live poll to
  answer), green when it is under way or done (in progress, handed in,
  scores published, drill available), zinc when it is over or neutral
  (locked, time was up, not started). One table per kind
  (`PROJECT_STATUS_TONE` for projects); a locked project wears `Lock` in
  its badge. Never the accent. A count is not
  a status: it stays plain text among the items.
- The **meta line** (`MetaLine` of `MetaItem`s), never one string joined by
  " · ". A project's card has two deliberate lines: first the timing
  (`CalendarClock`: the date and the time left, or "Closed … ago", then what
  the state adds), then, once a repository is ready, the work: the commit
  (`GitCommitHorizontal`: short hash in mono, date, number of commits), the
  CI badge ONLY when a run exists (never a dash in prose), the indicative
  score (`Gauge`, or `Lock` once frozen, with "indicative" and "at the
  deadline" as visible text; none after the release). The timing and the
  commit are one definition shared with the project page's header.
- **One button**, right. Its label may wear the GitHub mark (`GithubIcon`,
  `RowAction.icon`) when it leads to GitHub or to linking the account;
  never the accent for the mark. The accent is the button's alone, and
  the page decides which button has it (the home lights every open card,
  the classroom page its most urgent one); a ready repository never does.
- On a phone (390 px) the card is one column: icon, title and badge on the
  first lines, the items wrapping under them, the button on its own row.

The student's project page (`/projects/:id`) is the same card grown to a
page: the shell's width, a `Breadcrumb` in the eyebrow, the title alone in
the `h1`, then one line with the same status badge, the same timing and
commit (named "Last commit" or "Evaluated commit" in words), and the same
button; below, the repository (the invitation only while pending), the
latest CI run, and the score (or the result after the release) as stat
cards and a teacher's comment in one frame, at the rhythm of an
evaluation's results page. The CI and the score are not repeated in the
header.

## The participant's poll page (`/p/:CODE`)

One question on a phone in a lecture hall, reached by a QR code and often by
a reader with no account (F-AUTH-05, F-LIVE-13). It is the one screen the app
draws before the session gate, so it carries its own door.

- Column **560 px**, not the zen player's 760: a poll is a single question, and
  760 px of paper around it is a frame with nothing to frame. The gutter is the
  page's own — 16 px on a phone, 24 above it.
- The chrome is a 12 px uppercase eyebrow over a 16 px name; the reading size
  belongs to the question, drawn by the type's own player through
  `QuestionHost`. `PlayerShell` is NOT reused: there is no clock (a poll ends
  when the teacher says so), no progress strip over one question, and no
  hand-in dialog.
- ONE primary action, "Send", in a sticky bottom bar with a hairline over it —
  the thumb's half of the screen. It becomes "Update" once an answer is
  stored, and it is disabled while the stored answer is the one on screen.
  There is **no autosave**: a poll is one deliberate tap, and an answer that
  saved itself mid-gesture is an answer nobody meant to send. The whole sync
  report is a `success` check and the word "Sent", in a polite live region.
- **Only End takes the control away** (ADR-014, addendum 2026-09-29). While
  the poll runs, what the teacher shows — the key, the votes — sits in a
  second card UNDER the question, which keeps its "Send"/"Update" bar: a
  reveal that removed the control read as "you may not answer" to everyone
  who joined after it (poll KUFE5R). That card names no verdict (no "your
  answer — wrong" beside a field the reader may still change). Once the poll
  has ended the same block REPLACES the question and the verdict joins it.
  The key wears `success`, a wrong own pick `danger`, and both carry a WORD
  beside the tint (`PollJoinReveal`), because a lecture hall projector and a
  red-green reader both lose a tint alone. An mcq whose key and votes are both
  shown draws one list — the distribution with the key ticked in it.
- The type's own `Review` is deliberately not reused for that reveal: it is a
  GRADED surface (it always prints a score line, and `short` reads its verdict
  from grading details) and a poll produces none of that. A poll reveals the
  two facts it has — which answer is right, and which one this browser sent.

## The kiosk station (`/kiosk`) and the phone's pairing (`/pair`)

ADR-051 §7. A school Chromebook locked on `/kiosk` is read from a chair two
metres away, by a student holding a phone, and nobody clicks it. It is the
second screen, after the projections, where the 12–28 px scale does not
apply, and it borrows their rule: **type sizes in `clamp()` of the
viewport**, which here is the station's own screen (1366 × 768 for most of
them). Nothing else of the screen leaves the system.

- **The code is the one thing on screen.** `XXXX-XXXX` in mono,
  `clamp(56px, 7.5vw, 112px)` at 700 with `0.04em` tracking, never wrapped:
  it is typed letter by letter, and the mono face keeps `8` from `B` apart.
  The station's name above it is the page's heading at
  `clamp(28px, 3.4vw, 48px)` — the student compares it with the name on
  their phone, so it is read second, and smaller than the code.
- **No accent at all.** There is nothing to click on a kiosk; the one red
  element of a screen is the thing to click, so a station shows none.
- The code and the QR share one `surface` sheet (`rounded-sheet`, hairline),
  the QR on the left at `clamp(160px, 20vw, 280px)`. It is `PollQr`, the
  projection's tile, white in both themes for the same reason. The two steps
  under the sheet are an ordered list at `clamp(17px, 1.5vw, 22px)`.
- The countdown to the next code is `fg-muted`, tabular, and ticks each
  second through the app's one clock (`useNow`).
- **A station that cannot show a code says so in one sentence** —
  "Station not recognised" or "The station cannot start", then "Call the
  supervisor." — with no technical detail: the audit holds the reason. It
  stays on screen while the station tries again every 30 seconds; it does
  not flash back to "Starting" between tries.

The phone's page, `/pair`, is an ordinary gate page (`GateFrame`, 460 px):
the code field (mono, formatted as it is typed), then the station's name in
a `surface-2` panel at 20 px bold — the thing to check against the screen —
and the exams as one radio group. ONE primary action at a time: Continue
while there is only a code, then "Start on this station".

The supervisor's side (ADR-051 §6–8) lives in the live grid, not on a page
of its own:

- **How a student sits it is a badge in the name line**, after the name:
  nothing for the portal (most of the class, and silence is the default),
  `SEB` in zinc, or the station's label in zinc behind a `Monitor` icon,
  capped at 128 px and truncated (the whole label in its tooltip). A
  station whose attestation is not fine adds one more badge with
  `ShieldAlert`: `suspended` in red (its writes are refused), `not attested`
  in amber (Google cannot check it; nothing is blocked). The tooltip says
  which, in a sentence.
- **"Assign a station"** is a fourth row button (`MonitorCheck`), first in
  the row, on the rows still sitting, and only on an exam that accepts the
  kiosk; the actions column then widens from 104 to 120 px for every row
  (`ACTIONS_KIOSK`), so no row jumps. It opens a one-field `Modal`: the code
  as on `/pair` (mono, formatted as typed), one primary action, Assign. The
  station's label comes back in the success toast.
- A suspension and a session opened elsewhere are also said once in a toast
  (error, warning), naming the row as the grid shows it — the anonymous
  number when the names are hidden.
- On the station, a suspension covers the question exactly like the pause
  (`StationSuspendedOverlay`, the same panel): no action, what is saved is
  kept, and it lifts by itself.

## The launch checklist (evaluation, step 3)

The last step before a class can enter (issue #152, variant B). Its one
primary action is "Open the waiting room" — "Open" when the evaluation has no
waiting room — and "Schedule…" is its only secondary.

- A 20 px readiness heading ("Ready", "N things to look at", "Not ready yet")
  over ONE card of rows, hairline-separated. No score ring: a "5/7" would count
  information rows as checks, and it would borrow the shape of the lobby's
  presence ring for a different meaning.
- Four levels: a blocker (`danger` icon on a `danger-soft` row) is exactly
  what the API refuses, a warning (`warning` on `warning-soft`) has a fix, a
  passed check wears a `success` check, and an information row a neutral icon
  in `fg-faint`. Blockers and warnings sort first. The tints are semantic;
  the accent stays on the button.
- The levels and their icons are shared (`CheckLevel`, `LEVEL_ICON` in
  `ui/feedback.tsx`): also the GitHub checks of a classroom's Settings,
  where `unknown` is a `fg-faint` circle-question, never green.
- A row that leads somewhere is a button across its width: the name of the
  step it opens, underlined, on a desktop; a chevron on a phone. A fix done in
  place (updating stale versions) is a real secondary `sm` button instead, and
  so is a fix that needs a confirmation first (pulling a template revision,
  F-EVAL-26): its label ends in "…", and the button opens the dialog.
- The action bar is a card in the flow on a desktop and a **sticky dock** on a
  phone (`sticky bottom-0`, a hairline over it, full bleed): one status line,
  then the primary at full width with the secondary as a 40 px round button
  beside it. One DOM for both, so a label or a disabled state cannot differ.
  The status line says what the button will do, or why it cannot.
- "What students will see": the student's own `LobbyScreen` in `compact`
  (148 px ring, 20 px title, in a `div`), on `canvas` inside a hairline
  frame, in a 320 px sticky column from `lg` up; below `lg`, one chevron row
  that opens it in a sheet. It is a picture, never the connected lobby
  (ADR-018, fifth addendum), and it is absent when there is no waiting room.

## Connection recovery

A native modal dialog sits in the browser's top layer, above sheets and help,
and makes all underlying controls inert without unmounting their editors.
Its backdrop uses `canvas` at 65% with a 4 px blur, so the current task stays
recognisable. The centred panel uses the sheet radius, a hairline, 32 px
padding, a 20 px bold heading and 14 px muted copy. No accent and no primary
button: recovery is automatic. The existing spinner is still under reduced
motion. An ordinary failure has a 1.2 s grace to avoid flashes; an explicit
server shutdown appears immediately. Escape cannot dismiss the interruption;
focus returns to the previous control when it clears.

## The calculator (ADR-069)

A tool docked on the player when the evaluation provides one
(`apps/web/src/calculator/`), on the shared `ToolDock` (`src/ui/toolDock.tsx`).

- **The button**: a 48 px round button at the bottom right, 16 px from the
  edges (24 from `sm`), above the phone footer through `--player-footer-h`.
  `surface`, hairline and popover shadow: it floats over the page. Open, it
  takes the neutral ink fill of a pressed `ToggleChip` (`bg-fg`), never the
  accent, which stays the player's primary action.
- **The panel**: a non-modal floating layer 12 px above the button,
  `rounded-sheet`, hairline, overlay shadow; 288 px wide in standard,
  352 px in scientific, never wider than the screen less 32 px. It sits on
  `Z.tool`, over the sticky bars and under the pause overlay, the coach marks
  and every dialog. It traps nothing: the question stays readable and
  typable while it is open. Escape and its X close it, and focus returns to
  the button. The toasts rise above the button (`--tool-dock-h`).
- **The display**: the number at 28 px semibold, tabular, shrinking to 22
  then 18 px for a long one rather than wrapping; the expression above it is
  the 13 px muted line, cut on its LEFT when too long, because its end is
  what was just typed. Both sit in a `surface-2` well.
- **The keys are soft squares** (`rounded-field`), the one place where
  something pressed is not a pill: forty pills in a grid read as beads. Three
  tones, no accent: digits (and `.`, `+/−`) semibold on `surface-2`;
  functions and operators on `canvas` with a hairline, the four operators
  at 20 px (at the label's size `÷` and `−` are specks); `=` in the ink fill.
  4 px between keys; 40 px tall in scientific, 48 px in standard, the six
  trigonometry keys 32 px. DEG/RAD, `2nd` and `hyp` are neutral
  `ToggleChip`s above them; `2nd` swaps six keys in place (x² → x³, √x → ∛x,
  xʸ → ʸ√x, 10ˣ → 2ˣ, log → logᵧx, ln → eˣ) and the trigonometry to its
  inverses, as on Windows.

## The help assistant (ADR-080)

A chat docked on every teacher screen (`apps/web/src/assist/`), the
calculator's sibling: both are a `ToolDock` (`src/ui/toolDock.tsx`), which
owns the button, the non-modal panel, Escape and the focus's return, the
placement over an `offset` and `Z.tool`.

- **The button**: 48 px round, bottom right, 16 px from the edges (24 from
  `sm`), above the bottom bar through `--bottom-nav-h`. `surface`, hairline,
  popover shadow; a speech bubble with a question mark, which says "ask"
  without the help drawer's bare "?". Open, it takes the ink fill
  (`bg-fg`), never the accent: the screen's primary action keeps the one
  red. It is a tool dock (`data-tool-dock`), so the toasts rise above it
  (`--tool-dock-h`). Under `lg`, while the pool's bulk bar is up
  (`data-bulk-bar`), it steps aside (`style.css`): the bar spans the bottom
  edge there, and the selection is the task of the moment.
- **The panel**: a non-modal floating layer 12 px above the button on
  `Z.tool`, `rounded-sheet`, hairline, overlay shadow; 384 px wide, never
  wider than the screen less 32 px, at most 576 px tall and never taller
  than the window under the top bar. The page stays usable behind it;
  Escape or the cross closes it and focus returns to the button.
- **Inside**: a header (the 15 px bold title, a `zinc` badge when the
  development stub answers, then History, New and Close as small icon
  buttons); the conversation; the data notice, one 12 px `fg-faint` line
  above the composer, always there (what the assistant reads, students'
  names and results included, goes to Anthropic); the composer, pinned at
  the bottom. A
  question is a `surface-2` bubble on the right, at 14 px; an answer is
  plain 14 px text on the surface (the help drawer's Markdown: paragraphs,
  bullet and numbered lists, bold, code; a link only when it leads to the
  app's own origin — any other stays text, ADR-080 P2),
  never a bubble, so the reading weight is on the answer. The send button
  is a 36 px ink disc with an up arrow, dimmed while empty or waiting.
  Enter sends, Shift+Enter breaks the line.
- **States**: empty — a muted bubble icon, "Ask about this screen" and
  what it answers (the screen, the teacher's own data), kept 30 days and
  readable by an administrator; waiting — the question shown at once and a
  spinner "Looking it up…"; refused or failed — a
  `danger` `Alert` under the conversation, the draft kept; history — the
  retention line, then one row per conversation (its first question, its
  relative time, a danger icon button that deletes through `useConfirm`).

## The discovery page (`/discover`)

The one surface of the product read BEFORE an account exists: someone who
reached the door without access sees what is behind it. It is a page to
read and to be convinced by, not a tool, so it departs from the rules above
in four places, all confined to `src/discover/` (`discover.css` scopes them
under `.discover`):

- **The wordmark's four colours as section identity** (`--q-red`,
  `--q-yellow`, `--q-blue`, `--q-green`, the bubbles of `assets/quiz.svg`).
  Decoration only: a dot, a glow, a rule. Text stays in `fg` / `fg-muted`,
  and the one accent is still the sign-in button — the page's single primary
  action, the same door as the landing page.
- **Display type above the scale**: the hero headline goes to 72 px
  (800, `-0.035em`), section titles to 48 px. A product page has to be read
  from across a room; the 28 px page title is for screens one works in.
- **Looping motion.** Every scene is a miniature of a real screen drawn with
  the tokens (so it follows the theme by itself), runs only while it is on
  screen (`useInView`), and shows its end state under
  `prefers-reduced-motion` (`useStep` returns `STILL`). Scenes are
  `aria-hidden`: the text beside each says the same.
- **Shadows on the scenes' windows** (`--shadow-overlay`, `--shadow-popover`):
  they are pictures of floating windows, not cards in the page flow.

Language and theme are chosen in its top bar for this browser only (no
account to persist them to). It is drawn with no session and without
waiting on `/me`, like the kiosk station. The question-types section lists
exactly the types of `packages/registry/src/server.ts`; a type added there
gets a card here (`typeScenes.tsx`) and its strings in both dictionaries.
