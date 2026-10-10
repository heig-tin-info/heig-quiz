# ADR-092 — Festive touches: the logo dresses up on a few days of the year

## Status

Accepted (2026-10-09, product owner Yves Chevallier, on a mockup; the colours,
the duration and the way into the sheet settled on 2026-10-10). F-UI-01.

Scope: what the web app draws on a festive day — the logo's accessory, the
ambient layer, the day's sheet — where it may draw it, and its setting.

Relations: amends `apps/web/DESIGN.md` (Motion, and the Logo entry of the
components): a third decoration allowed outside the motion rules, beside the
logo's dance and the coach marks. Placement follows ADR-087's "home and lists"
rule (`whatsNew` of `ROUTES`).

## Context

The PO asked for Google-style easter eggs: on Christmas, Easter or a computing
pioneer's birthday, a costume on the logo, a playful animation, and a short
sheet about the day with a Wikipedia link — with a minimal code and bundle
footprint, and nothing at all during an exam. Three rules stood in the way:
`DESIGN.md` reserves the logo's four colours to the logo; WCAG 2.2.2 (level A,
within N-A11Y-01) requires a pause or stop control for motion that starts on
its own and lasts more than five seconds; and the logo is already the home
button, which cannot hold another button.

## Decision

1. **A calendar of ten days**, in the order of the academic year:
   Programmers' Day (the 256th day), Ada Lovelace Day (second Tuesday of
   October), Grace Hopper (9 December), Christmas (15 December – 6 January),
   Linus Torvalds (28 December), Brian Kernighan (30 January), Pi Day
   (14 March), Easter (Good Friday – Easter Monday, Gregorian, computed),
   May the 4th, Alan Turing (23 June). Nothing in July and August. When two
   periods hold a day, the shortest wins (Torvalds over Christmas). The date
   is the browser's: a costume is cosmetic, never a deadline.
2. **The accessory** is an SVG fragment slipped into one bubble's group of the
   inlined logo, so it dances with its bubble; `quiz.svg` stays untouched. Its
   colours are a drawing's, like the logo's, outside the token scale.
3. **The ambient layer**: sprites in one of three CSS modes — fall, drift,
   burst — behind every surface (z −1), a burst coming out of the logo over
   the page (`Z.festive`, under the coach and every dialog). **Five seconds at
   most, once a day per browser**, so no control is needed (WCAG 2.2.2).
   Its sprites take the `--fx-*` pastels; the logo's colours stay in the logo.
4. **Where**: the Shell draws all of it, so the full-screen views (attempt,
   previews, poll and correction projections), confined `seb` and `kiosk`
   sessions and the signed-out page (a kiosk station before pairing) get
   none — by construction, not by a check. The folded sidebar's Q bubble
   stays bare. The layer plays only on the views ADR-087 opens What's new on
   (the home and the lists, never mid-task; the live dashboard is not one),
   after What's new has been closed, and stops when the page is left; a
   coach mark (z 45) stays above a burst. A
   teacher projecting an ordinary page cannot be detected: the setting is the
   way out. A student with an attempt open in another tab still sees it on
   the home; the integrity journal (ADR-088) records nothing of it.
5. **The sheet**: a button laid exactly over the accessory, beside the home
   button and not inside it, with its own label ("Happy holidays: learn
   more"), opens a modal: the dressed logo, two or three sentences, the
   Wikipedia article in the interface language. The rest of the logo still
   goes home.
6. **The setting**: Settings › Preferences › Festive touches, on by default,
   kept in the browser like the theme. Under `prefers-reduced-motion` the
   layer never plays and the accessory sits still.
7. **Footprint**: the calendar is always loaded (about 2 KB); the drawings and
   their CSS are one chunk (about 4 KB gzipped) fetched on a festive day only.

## Consequences

- Adding a day is one calendar row, one `ART` entry and two `en`/`fr` keys.
- A new decoration rule in `DESIGN.md`, to keep exceptional: anything else
  that moves on its own still follows Motion.
- The tests pin the calendar (Easter, leap years, overlaps) and that an
  attempt and a `seb` session draw nothing.

## Alternatives considered

- **Detecting "an exam is running somewhere"** to switch the costume off: the
  frame never draws during an attempt already; a second tab is not the exam.
- **Fifteen seconds with a stop button** (the mockup): a control nobody needs
  for a five-second run.
- **The logo click opening the sheet** (as on Google): it would take the home
  link away for a day.
- **A per-account setting**: a costume is a habit of the screen, like the theme.
