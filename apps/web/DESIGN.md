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
| `info` / `info-soft` | `#1268a0` / `#e8f2f9` | `#58a9e0` / `rgb(88 169 224 / 0.14)` | "a set of possibilities", and the progress half of a cell state |

Rule: strip the accent and every screen must still read. Hierarchy comes
from size, weight and position, never from red.

`info` is the calm blue of the logo's "I" bubble (`#0086d1`) taken down to
reading weight — not a saturated link blue, which would read as "click me" in
a page where the one thing to click is red. Its first job is one
distinction: a `{{…}}` chip in the cloze editor holding ONE answer wears the
accent, and one standing for a SET of possibilities (several answers, or a
dropdown) wears this. A teacher scanning a paragraph of holes tells the two
apart without reading a word of them.

Its second job is the PROGRESS half of a `VerdictCell` — `info-soft` for a
question the student has written in, the `info` fill for one they have marked
done — and it is the same job seen from another side: green, amber and red on
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
- Content column: 1120 px max, 24 px side gutter (16 on phones).
- A navigation list is capped, not scrolled: the sidebar shows twelve
  classrooms and a "Show all (N)" row, always including the one being read.
  Thirty names in a column is a wall, and it pushes the account row off.

## Shape and elevation

- Radii: controls (buttons, chips, segmented, avatars) are **pills**;
  fields 10 px; cards 12 px; sheets and dialogs 16 px; menus 12 px.
  Pills on everything you press, soft squares on everything that holds.
  Each of those was one step larger (12 / 16 / 20 / 14) and the previous
  radii read as soft and toy-like next to dense tables: the pool table, the
  live grid and the grading list are the screens this product is for, and a
  16 px corner around a 13 px row makes the card louder than its contents.
  The pills are untouched — they mark what you press, and that distinction is
  the point of the scale.
- Separation language: **1 px hairlines** (`line`), one surface level below
  for recessed panels (`surface-2`). No shadows on anything in the page
  flow. Shadows exist only on floating layers (menu, popover, sheet, dialog,
  toast), because those genuinely sit above the page.
- Focus: 2 px accent ring at 2 px offset, on every interactive element. It is
  declared once in `style.css` on `:focus-visible`; no component restyles it.

## Keyboard and focus

A floating layer is not finished until it behaves. `useLayer` in `ui.tsx`
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

`Menu` follows the WAI-ARIA menu button pattern: `aria-haspopup="menu"` and
`aria-expanded` on the trigger (cloned onto a custom one), Enter / Space /
ArrowDown open on the first item and ArrowUp on the last, arrows wrap,
Home/End jump, Escape and Tab close and hand the focus back to the trigger.
Items are `role="menuitem"` with `tabIndex={-1}`.

`Tabs` uses a roving tabindex: one tab in the Tab order, ArrowLeft/ArrowRight
move and select with wrap, Home/End jump. A `value` matching no item still
leaves the first tab reachable, so a hand-edited URL cannot take the whole
strip out of the Tab order.

An element made clickable without being a button (a card, a table row) takes
`pressable()` from `ui.tsx`: `tabIndex={0}` plus Enter and Space, with Space
prevented from scrolling the page. A row keeps `role="row"`; announcing it as
a button would cost the reader the table around it.

Ctrl+K (⌘+K on Apple keyboards) opens and closes the command palette, from
anywhere, including from inside a field: that is the convention wherever the
shortcut exists, and the default is prevented because Firefox otherwise takes
it to its own search bar. Alt or Shift held, the event is the browser's.
Inside the palette the arrows move the selection, Home and End jump, Enter
runs and Escape closes, all without the focus ever leaving the search input.

`Tip` never takes the focus (portal, `pointer-events-none`, `aria-hidden`)
and Escape dismisses it.

A label cut by an ellipsis carries a `Tip` with the whole of it — the
sidebar's classroom names first, which outgrow 240 px routinely. The `Tip`
wraps the ROW, so the name reads the same on hover and on Tab, and it is
armed only when the label is REALLY cut (`useTruncated`, which measures
`scrollWidth` against `clientWidth`): a bubble repeating a label the eye
already reads is noise on every row of the list.

Toasts sit in one `aria-live="polite"` region, each one a `role="status"`
with a keyboard-reachable dismiss button.

## Motion

- 120 ms for micro feedback (hover, press), 200 ms for panels and menus,
  260 ms for sheets. Easing `cubic-bezier(0.2, 0, 0, 1)`. Presses scale to
  0.97. Honors `prefers-reduced-motion`.

## Components

- Button: `primary` (accent fill, white text, one per screen), `secondary`
  (surface, hairline), `ghost` (no chrome), `danger` (danger fill, never
  primary-styled elsewhere). Sizes `sm` 28 px, `md` 34 px, `lg` 40 px.
- Icon button: round, ghost; `danger` turns red on hover only.
- Badge: pill, soft background, 12 px, tones green / amber / red / zinc /
  accent. Status is a badge; a count is plain text.
- Card: `surface` + hairline + 16 px radius; padding 16–20.
- PersonAvatar: a person as a round picture, or their two initials on
  `surface-3` in `fg-muted` when there is no picture OR when it fails to load
  (an IdP picture URL goes stale, and a broken-image glyph is not a face).
  The signed-in user's own disc (`Avatar`) takes the `accent` tone. An
  avatar standing alone — the row of a course's staff — carries the full
  name as its accessible name and as a `Tip`, never a native `title`; one
  with the name written beside it (a roster row) carries neither. It exists
  because three places drew "a picture, or initials", and two of them had no
  fallback.
- ParentLink: the way back up, as the `PageHeader` eyebrow — the parent's
  name (a course, a pool, a classroom) as a plain button. The eyebrow sets
  the 13 px `fg-muted`; the link adds `fg` AND an underline on hover, with
  the colour transition every hover has. The underline stays because the
  resting link is the same grey as the caption it replaced, and colour alone
  is a weak signal of "this goes somewhere" — the roster's mailto links wear
  the same pair. A name that does not say where it leads takes a `Tip`
  (`tip`), never a native `title`. It exists because six pages wrote that
  button with two different class lists.
- Logo: the product's wordmark (`src/assets/quiz.svg`), four speech bubbles
  spelling Q U I Z, as an `<img alt="Quiz">`. It is the file, not inline JSX:
  the same mark is delivered elsewhere, and a retyped copy is a second
  version to keep in step. Its four colours are its own and live outside the
  token scale — nothing else on a screen may use them. `className` carries
  the WIDTH and the height follows, because it is a drawn word and is sized
  like a word: 100 % of the sidebar (about 200 px), 112 px in the phone top
  bar and in the drawer, 220 px on the signed-out page, where it IS the `h1`
  and the 28 px title under it is gone — it said "Quiz" a second time.
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
- Field: label 13 px 500 above, 12 px radius, `line-strong` border, accent
  ring on focus. The `<label>` covers the text only and points at the control
  through `htmlFor`; the help "?" is its sibling, never inside it, or that
  button becomes the labelled control and the input loses its name. Two heights, from the button scale: `sm` 28 px for a control
  inside a table row, `md` 34 px everywhere else (`inputSize` in ui.tsx).
  Width is a prop, never a class beside `inputClass`: Tailwind settles two
  width or height utilities on one element by their order in the generated
  stylesheet, not by the order they were written in.
- Help "?" (`HelpIcon`): **16 px**, `fg-faint` at rest, accent on hover, the
  same beside a 28 px page title, a 16 px section heading and a 13 px field
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
- Segmented: `surface-3` pill track, selected chip raised to `surface`.
  Segmented is ONE choice out of a set small enough to show whole — two or
  three normally, five at most and only with one-word labels (the pool
  toolbar's "Group by" and "Sort by"); ToggleChip is any number out of many.
  Do not use one for the other's job, and do not reach for a `Select` just
  because there are four options: a select hides the set until it is opened,
  which is the wrong trade for a control the reader sets once and then reads.
  A track with no visible caption takes `label`, which becomes the
  `aria-label` of the radiogroup — two anonymous pill rows side by side are
  indistinguishable to a screen reader.
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
- Sheet: right drawer, 560 px, for every form longer than three fields.
  Dialog: centered, ≤ 480 px, for confirmations and one-field forms.
  A sheet never opens another sheet; a dialog may open over a sheet.
  One exception, `size="xl" scroll`: a READING dialog, 920 px, whose body
  scrolls under a title and a footer that stay put. It is not a form — it is
  a document the reader walks through, today the whole of one student's
  answers opened from the live grid — and the footer is how they walk to the
  next one, so it must not sit at the bottom of a hundred lines of code.
- FormDialog (`ui/forms.tsx`): the short form in a dialog — one to three
  fields, Cancel (`common.cancel`, always) and ONE submit button whose label
  is the verb ("Create course", "Save"), spinner while `submitting`, disabled
  until `canSubmit`, and the failure under the fields. It exists because
  seven dialogs wrote that footer out by hand, each one a chance to drift.
  It deliberately has no `size`: a fourth field is
  the sign the form belongs in a `Sheet`, never a reason to widen the
  dialog. `dense` (12 px between rows instead of 16) is for a body that is a
  single row.
- Menu: overflow for tertiary actions; destructive items last, separated. It
  closes on a page scroll, but not on the scroll its own opening click causes
  (200 ms of grace) nor on one inside the panel. Its panel stacks ABOVE the
  dialog layer (`Z.popover` > `Z.modal`), because menus open from inside
  sheets, dialogs and the mobile drawer. An item may carry a `description`,
  a second 12 px muted line, when the label alone loses what the action does.
  An item's `disabled` describes the state when the menu was opened, never a
  busy state: picking an item closes the menu, so a pending flag there is
  invisible. A toast reports the progress instead.
- Toast: bottom-right, `surface` + hairline + overlay shadow. Tones
  `success` / `error` / `warning`, plus `progress` (a neutral spinner) for
  "this has started", which is the only report an action taken from a menu
  can get. A failed mutation reports through `useErrorToast()` (`notify.tsx`):
  `onError: toastError("error.save")` — the server's message or the
  translated fallback key, always in the `error` tone, so no call site can
  pick another one.
- Empty state: icon in a `surface-2` circle, title, one line, one action.
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
  language (hairline at rest, `accent-soft` on an `accent` border when it is
  the current one). A tile's label is the RAW lucide name (`flask-conical`),
  untranslated on purpose: it is an identifier, like a SHA or a tag, and in
  the search step it is the very string the reader typed.
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
  screen reader nor a red-green reader.
- Ring: SVG progress ring for the lobby's "present / enrolled" and the
  dashboard's completion. `fg` and not the accent — on the waiting screen it
  is the only living element, and a red disc would read as an alarm on a page
  whose whole message is "there is nothing to do". `label` names the figure;
  the middle is `aria-hidden`, or the reader hears the numbers twice.
- ProgressSegments: one bar per question in the zen player, four states
  (`empty` never opened, `answered` opened and left, `done`, `current`). It
  spans the WHOLE width it is given and the bars share it equally, with no
  cap: the strip is a map of the paper, and three questions drawn as three
  stubs at the left edge map nothing. Every bar carries its NUMBER under it,
  quiet (`fg-faint`, 11 px) except the current one, which is the accent and
  bold — a student aims at "question 7" instead of counting bars. Roving
  tabindex like `Tabs`, because twenty questions must not be twenty stops on
  the way to the answer field; the state is in the accessible name, not only
  in the height.
  Past a certain count the numbers stop fitting, and the strip COMPRESSES
  rather than wrapping or scrolling — the bars are what the strip is for, so
  they stay and the numbers thin out to anchors. Measured on the strip's own
  width (a `ResizeObserver`, never the viewport: the same strip is 760 px in
  the player and 358 px on a phone): a segment of 22 px or more holds two
  digits and its air, so everything is numbered (about 30 questions over
  760 px); from 11 px, the first, the last, the current and every 5th; under
  that, every 10th. A multiple landing within two slots of the last one is
  dropped, so "30" and "32" never collide, and the gap halves to 2 px once
  compressed to give the bars back what the air was taking. Nothing is lost:
  the number and the state live in each bar's accessible name, which never
  thins out.
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
- VerdictCell: one cell of the live grid and of the grading list, eight
  states in two families. PROGRESS — `blank` (nothing), `inProgress` (opened,
  nothing written, neutral), `answered` (written in, `info-soft`), `done` (the
  student marked it done, the `info` fill) — and VERDICT, which the grid's
  "Results" switch puts in their place: `correct`, `partial`, `wrong`,
  `pending`. Icon **and** tint **and** word, never a tint alone: a dashboard
  projected on a lecture-hall wall loses half its saturation. `value` holds
  the answer in a glyph or two ("A, C", "NULL", "12 L") beside the icon, and
  INHERITS the state's ink rather than carrying `fg` — that is what keeps it
  readable on the filled `done` blue, where `fg` measured 2.9:1.
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
  of icons. MarkdownField around it is a label and the upload adapter — no
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
  Nothing else in `apps/web` may use a `clamp()` type size.
  The question's own step is picked from its LENGTH (`questionScale`): a
  one-line question gets the full 68 px, and two longer steps follow, because
  a four-line question at 68 px pushes the last bars off the wall — and
  nothing on this screen may be truncated, since a question is read, not
  summarised. From `sm` up the stage IS the viewport (`h-dvh`, no page
  scroll): the session code and the QR stay on the wall whatever the question
  costs, and only the middle band gives way. The distribution shows at most
  eight rows and counts the rest in one muted line: a free-text tally carries
  up to sixty distinct spellings, and sixty bars is a wall of noise.
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
  the stage (mockup 10 has them in the footer; the product does not). The
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

## Tables

At most seven visible columns, one dominant identity column, numbers right
aligned and tabular, status as a `Badge`, actions last, `—` for an empty
cell. All of it lives in `T` in `ui.tsx`.

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

A row with a `colSpan` needs care: a cell spanning a column the container has
hidden leaves that row one column wider than every other one, and the table
shears. An inline edit row gets one cell per column, empty ones included.

Applied today: the pool table (version, updated, tags), the roster (last
sign-in, accommodation, e-mail), the evaluation list (attempts, points,
questions) and the grade table (duration, e-mail).

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

## Voice

Sentence case everywhere. Buttons start with a verb ("Create question",
"Publish"). Status words are lowercase in badges. Every surface, teacher and
student alike, goes through `t()` with an `en` and an `fr` entry (N-I18N-01).

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
- **Reveal replaces the control.** Once the teacher has revealed — and on a
  poll that has ended — the answer control is gone rather than disabled with a
  key beside it: an input that still accepts a tap after the room has read the
  answer is a trap. The key wears `success`, a wrong own pick `danger`, and
  both carry a WORD beside the tint (`PollJoinReveal`), because a lecture hall
  projector and a red-green reader both lose a tint alone.
- The type's own `Review` is deliberately not reused for that reveal: it is a
  GRADED surface (it always prints a score line, and `short` reads its verdict
  from grading details) and a poll produces none of that. A poll reveals the
  two facts it has — which answer is right, and which one this browser sent.
