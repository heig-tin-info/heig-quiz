# ADR-104 — One state grammar for the staff's badges: green open, amber awaited, outline finished

## Status

Accepted (2026-10-11, product owner Yves Chevallier).

Scope: the state badge of an evaluation and of a project on every staff
surface of `apps/web` (the classroom's Activities tab, `/activities`, the
evaluation's configuration, the live header, the project page) and the bars
of the Activities gantt. The student's surfaces (the activity cards,
`student/projectRow.ts`, the grades and feedback pages) keep their own
grammar and are not governed here.

Relations: amends `apps/web/DESIGN.md` (the Badge entry); reverses two
delivered choices recorded in `docs/merge/history/09-tasks-delivered.md` —
M3-10 ("amber badge and bar" for a published project) and M3-14a finding
no. 6 (the time left in the Projects table's Deadline cell). Builds on
ADR-094 (the `packages/ui` class lists).

## Context

A classroom's Activities tab stacks two tables, the evaluations and the
projects, each with a state badge drawn from its own colour table. Amber
meant two things there: on an evaluation, "the staff is awaited" (the lobby,
a pause, the grading); on a project, "open, nobody is in the room"
(M3-10). A running evaluation and a released one were both green, so the
one state a teacher scans the list for — the students are in now — had no
colour of its own. The time left of a published project sat in its Deadline
cell as a relative distance (M3-14a no. 6), while a running evaluation showed
none, and the gantt's legend had to spell "waiting room, paused, open
project" under one amber swatch.

## Decision

1. **One grammar, for staff surfaces only.** Green = open to the students
   (an evaluation `running`, a project `published`). Amber = the staff's own
   correction or publication is awaited (`lobby`, `paused`, `grading`). Zinc
   = at rest (`draft`, `scheduled`, `closed`, `locked`). Outline, green =
   finished with nothing awaited (`released`). One table per kind holds the
   tone and the face together (`stateStyle` in `evaluation/common.ts`,
   `projectStateStyle` in `project/common.ts`); `KIND` in
   `activities/model.ts` reads them, no view branches on a state's colour.
2. **An outline face of the badge**, in `packages/ui` (`badge(tone, extra,
   "outline")`, `variant="outline"` on `Badge`): no fill, the tone's ink, a
   1 px inset ring in the same colour (`ring-current`), for every tone. No solid-fill
   variant: the soft green plus the timer is what marks a live row, and a
   solid pill would compete with the row's one primary action (invariant 2
   of `CLAUDE.md`).
3. **The timer** — a `Timer` glyph and the time left in the largest non-zero
   unit, to the minute ("4 d", "3 h", "35 min", "<1 min", never negative),
   `TimeLeft` in `ui/dates.tsx`, ticking on the shared minute timer of
   `useNow` — rides inside the badge, after the label, in exactly two
   places: the evaluations list and the Projects group of a classroom's
   Activities tab, and only while the students are in (`running`,
   `published`; never a lobby or a pause, where nothing runs out). Everywhere
   else the badge wears the tone and the face alone: the live header has the
   screen's one clock, the project page shows the deadline, `/activities`
   has its Closing column. The Projects table's Deadline cell keeps the
   absolute date only.
4. **The gantt's bar is derived from the badge's tone**: green and amber
   fill at full strength; three exceptions a badge does not draw stay
   explicit — a dashed outline for a draft, an info ring for what is
   scheduled, the recessed surface for everything over. The outline face
   never reaches a bar. The legend reads "open to students" and "waiting
   room, paused".

## Consequences

- A published project turns from amber to green on every staff surface and
  on the gantt — the reversal of M3-10's "amber badge and bar", which had
  read amber as "open but nobody is in the room"; openness, not presence, is
  what the colour says now. A released evaluation turns from soft green to
  outline green.
- The time left leaves the Projects table's Deadline cell for the badge —
  the reversal of M3-14a finding no. 6, whose answer ("the deadline cell of a
  published project says the time left") is now given by the badge, with a
  live minute tick that finding had declined.
- Two strings move: the gantt's legends. Five keys arrive (`time.left.*`,
  `time.closesIn`) in both languages.
- The student's cards are untouched: their amber still means "a step waits on
  the student", a rule of their own that `DESIGN.md` keeps beside this one.
- A future kind of activity declares its tone, its face and its timer
  deadline in its `KIND` entry and inherits every surface.

## Alternatives considered

- **A solid-fill variant for the live states.** Rejected: a saturated pill on
  a row with a primary button is a second thing to click; the soft tone plus
  the timer reads "live" without weight.
- **The timer everywhere the badge appears.** Rejected: the live header
  already carries the screen's one clock (#227), and a page with two
  countdowns of the same deadline invites a disagreement; the tables of the
  Activities tab are the only staff surface with no clock at all.
- **Keeping amber for a published project.** Rejected: one colour with two
  meanings in two tables that sit one above the other.
