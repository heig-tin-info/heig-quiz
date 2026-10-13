# ADR-104 — One state grammar for the staff's badges: green open, amber awaited, blue scheduled, outline finished

## Status

Accepted (2026-10-11, product owner Yves Chevallier).

Amended 2026-10-13 (#798): §3 for the project page only — the lifecycle
rail carries the page's one clock
([amendment](#amendment-2026-10-13-the-project-rail-carries-its-own-clock)).

Amended 2026-10-13 (#786, #795): §1's zinc, §4's scheduled bar and §5's
phases — blue for what is scheduled, a project's `scheduled` phase, and the
rule for any further pill tone
([amendment](#amendment-2026-10-13-blue-for-what-is-scheduled-and-the-rule-for-a-new-pill-tone)).

Amended 2026-10-13 (#794): §3's format — two units instead of the largest
one, and the seconds in the last ten minutes
([amendment](#amendment-2026-10-13-the-time-left-in-two-units)).

Scope: the state badge of an evaluation and of a project on every staff
surface of `apps/web` (the classroom's Activities tab, `/activities`, the
evaluation's configuration, the live header, the project page) and the bars
of the Activities gantt; and, for a project, the server-derived phase the
badge reads (§5): `ProjectPhase` in `packages/contracts`, `projectPhase` in
`packages/domain`, and the phase counts of the staff's project lists in
`apps/api` (`phaseCounts`, `views.ts` of the `project` module). The
student's surfaces (the activity cards, `student/projectRow.ts`, the grades
and feedback pages) keep their own grammar and are not governed here, and
no student contract carries the phase.

Relations: amends `apps/web/DESIGN.md` (the Badge entry); reverses two
delivered choices recorded in `docs/merge/history/09-tasks-delivered.md` —
M3-10 ("amber badge and bar" for a published project) and M3-14a finding
no. 6 (the time left in the Projects table's Deadline cell). Builds on
ADR-094 (the `packages/ui` class lists).

The two 2026-10-13 amendments amend `apps/web/DESIGN.md` again: #798 the
project page's Lifecycle rail and Deadline tile, #786/#795 the Badge entry.

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
   `projectPhaseStyle` in `project/common.ts`, keyed by the phase of §5); `KIND` in
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
5. **A project's phase.** A project's stored state stops at `locked`, but
   behind it the staff must tell apart what an evaluation's `closed`,
   `grading` and `released` tell apart. The staff's project summaries and
   the project page carry a derived **phase** — `draft | published | locked
   | graded | released` (`projectPhase` of `@quiz/domain`, `ProjectPhase` of
   the contracts) — and the badge reads it; the buckets, the sorting and the
   gantt keep reading the state. `draft` and `published` follow the state;
   `locked` refines into `locked` (the scores are not final), `graded` (final
   per `scoresFinal`, the staff's release awaited: amber, an evaluation's
   `grading`) and `released` (`releasedAt` set: outline green, a released
   evaluation). Labels: "graded" / "released", "corrigé" / "rendu" — never
   "publié", which already names a published project. Three choices of the
   product owner (2026-10-11): the state comes first, so a project moved back
   to `published` by a later deadline is `published` even with its
   `releasedAt` kept (F-PROJ-09); a released project whose scores changed
   since stays `released` on the list — the page's primary action already
   says a re-release waits, and `changedAfterRelease` is not computed for a
   list; a project graded `none` never has final scores, so it stays `locked`
   after its deadline. The list stays cheap (F-PROJ-13): the counts behind
   the phase come from one query, one row per live student repository of the
   locked projects listed, their slot runs joined, no GitHub call and no
   project detail loaded.

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
  `time.closesIn`) in both languages, then two (`project.state.graded`,
  `project.state.released`) with the phase.
- `phase` joins `state` on `ProjectActivitySummary` and `ProjectDetail`,
  staff contracts both; no student contract or view gains it (invariant 4 of
  `CLAUDE.md`). A locked project's row costs the list one query over
  its repositories and their slot runs; a draft or a published one costs
  nothing more.
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

## Amendment 2026-10-13: the project rail carries its own clock

Settled with the product owner on 2026-10-13 (#798, asked by a teacher). It
amends §3 for the project page only; the badge's timer, its two places and
the rest of this record stand.

1. **The clock.** While a project is `published` and the server has not
   applied its deadline (`deadlinePassed`, the server's word — invariant 5
   of `CLAUDE.md`), the lifecycle rail (`ProjectRail`) fills its line from
   Published toward the Deadline in proportion to the time elapsed from the
   publication to the deadline (clamped 0..100 %), and writes the time left
   under the deadline's date through `TimeLeft` — §3's format, on the shared
   minute timer of `useNow`, no new clock. Each segment between two markers
   fills by its own two dates: the markers are evenly spaced, so a straight
   fraction would cross a review checkpoint at the wrong time. The value
   given to a screen reader is the overall fraction.
2. **The colour: the `accent`.** The bar and the figure are not a control,
   so they are not a second primary action: the header's one primary button
   (Publish, Sync, Release — invariant 2) stays the only accent a teacher
   acts on, and with the accent stripped the rail still reads.
3. **The page's only clock.** §3 rejected two countdowns of the same
   deadline on one page, so the Deadline tile (`ProjectOverview`) drops its
   relative line while the rail carries the time left, and keeps "passed"
   once the server applied the deadline.
4. **After the deadline the rail is the plain one**: no bar and no time
   left, the done markers already say it is over. Completing the segment in
   a neutral ink was set aside as one more mark saying the same thing.

## Amendment 2026-10-13: blue for what is scheduled, and the rule for a new pill tone

Scope: §1's zinc, §4's scheduled bar, §5's phases, and how the grammar
grows. Decided by the
product owner on 2026-10-13, after a teacher's two reports: a scheduled
evaluation's grey pill read as a draft's (#786), and every project he had
scheduled still said "draft" exactly like one in preparation (#795).

1. **Blue = scheduled**: ready, and it will open on its own at a known
   time. An evaluation `scheduled` and a project in the `scheduled` phase
   wear the soft blue — the `info` tone of `packages/ui`'s `badge`, `blue`
   in `apps/web`'s `Tone`, the token the gantt's scheduled bar and its
   legend already wore (§4). Zinc keeps what is at rest: a draft still in
   preparation, `closed`, `locked`. The two tone tables stay the only place
   a state meets its colour (`STATE_STYLE` in `evaluation/common.ts`,
   `PHASE_STYLE` in `project/common.ts`).
2. **A project's `scheduled` phase.** §5's phases become `draft |
   scheduled | published | locked | graded | released`: a project in the
   `draft` state whose publish mode is `scheduled` (the create and
   patch contracts then require its start) is `scheduled`; a draft published by hand stays
   `draft`. Labels "scheduled" / "planifié". As §5 says, the buckets and
   the sorting keep reading the state.
3. **The gantt's scheduled ring follows the tone.** §4's info ring is now
   drawn for a bar whose badge is blue (`KIND`'s `stateStyle`), so a
   scheduled project wears it as a scheduled evaluation does; the dashed
   draft outline stays for a draft in preparation. The `/activities` tabs
   first filed a scheduled project under Drafts, by its state; since #787
   (2026-10-13) `tabOf` in `activities/model.ts` files it under Current,
   beside a scheduled evaluation (`isScheduled`, which the "Scheduled"
   filter of `/activities` and of a classroom's Activities tab also reads).
   A scheduled project's start and deadline therefore now count in the
   "Next 7 days" tile, in `nextEventOf` and in the classroom list's next
   event (#805, `course/classroomSignals.ts`), which read `tabOf`.
4. **The start in sight.** The evaluations table of a classroom's
   Activities tab gains a Start column — when it started (`startedAt`, an
   evaluation opened by hand has no `opensAt`), else when it is to open
   (`opensAt`), as an absolute date and time, a dash when neither is set —
   as the Projects table under it already had, so a scheduled row says
   when it begins without opening it. A row without a date sorts last in
   either direction. Since #787 an End column (`closesAt`) follows it, as
   the projects' Deadline follows their Start.
5. **Nothing blinks.** The suggestion that a running badge blink (#786) is
   declined: motion pulls the eye from the row's one primary action, and
   the soft green with its timer (§3) already marks a live row.
6. **A new pill tone needs a meaning of its own.** A pill tone joins this
   grammar only for a meaning distinct from the ones it holds — green open
   to the students, amber awaiting the staff, blue scheduled, zinc at rest,
   the outline finished — and only by an amendment of this record that
   names it, with its tokens readable at 4.5:1 in both themes and its entry
   in the tone tables of item 1. A pill is never the accent: the brand red
   belongs to the screen's one primary action.

## Amendment 2026-10-13: the time left in two units

Decided by the product owner on 2026-10-13 (#794, asked by a teacher: a
project said "1 h" with 1 h 40 min left). It replaces §3's format — "the
largest non-zero unit, to the minute, never a second" — everywhere
`TimeLeft` is used (the badges of §3, the project rail of the first
amendment); where the timer rides and what it means stand.

1. **Two units, floored.** From a day: days and hours ("2 d 5 h", fr
   "2 j 5 h"). Under a day: hours and minutes ("1 h 40 min", fr "1 h 40",
   the minutes on two digits as French writes a time). Under an hour:
   minutes ("35 min"). Under ten minutes: minutes and seconds
   ("9 min 32 s", "45 s"). A second unit that is zero is left out ("2 d",
   "3 h", "5 min"). Still floored — a badge never promises more than what
   is left — and still never negative: a deadline just passed (the +3 s
   grace of invariant 5, a project's lock within the minute) reads "0 s"
   until the state catches up; "<1 min" is gone, the seconds say it.
2. **The second timer only in the last ten minutes.** `TimeLeft` ticks on
   the shared minute timer of `useNow`, and on the shared second timer
   only while under ten minutes and before the deadline, so a list of
   rows does not re-render every second for deadlines days away. A timer
   armed for the ten-minute mark switches it at that exact moment.
3. **Not the other clocks.** The live header's countdown and the Super
   Powers banner keep `formatRemaining` (`ui/live.tsx`), a by-the-second
   countdown rounded up, which they need for a screen with one clock to
   watch; this amendment is about a figure on a row.
