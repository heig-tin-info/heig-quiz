# ADR-104 — One state grammar for the staff's badges: green open, amber awaited, blue scheduled, outline finished

## Status

Accepted (2026-10-11, product owner Yves Chevallier); consolidated on
2026-11-08 from its seven amendments (2026-10-13 ×3, 2026-10-14 ×2,
2026-10-26, 2026-10-29) and the amendment of 2026-11-06 by
[ADR-127](ADR-127-etat-planifie-des-projets.md) (a project's `scheduled`
phase is its `scheduled` state). This consolidation changes no decision. The
[historical record](history/ADR-104-badges-d-etat-unifies.md) keeps the
original text, the reports that led to each amendment and the delivery
notes; the [correspondence table](#correspondence-of-old-references) maps
each old section.

Scope: the state badge of an evaluation and of a project on every staff
surface of `apps/web` (the classroom's Activities tab, `/activities`, the
evaluation's configuration, the live header, the project page), the bars
of the Activities gantt, the project page's lifecycle rail, and, for a
project, the server-derived phase the badge reads (§5): `ProjectPhase` in
`packages/contracts`, `projectPhase` in `packages/domain`, and the phase
counts of the staff's project lists in `apps/api` (`phaseCounts`, `views.ts`
of the `project` module). The student's surfaces (the activity cards,
`student/projectRow.ts`, the grades and feedback pages) keep their own
grammar and are not governed here, and no student contract carries the
phase.

Relations: amends `apps/web/DESIGN.md` (the Badge entry, the project page's
Lifecycle rail and Deadline tile); reverses two delivered choices recorded
in `docs/merge/history/09-tasks-delivered.md` — M3-10 ("amber badge and bar"
for a published project) and M3-14a finding no. 6 (the time left in the
Projects table's Deadline cell). Builds on ADR-094 (the `packages/ui` class
lists). [ADR-086](ADR-086-planifiee-ou-en-direct.md#amendment-2026-10-14-the-scheduled-mode-is-labelled-automatic)
owns the names of an evaluation's clock ("Automatic" / « Automatique »).

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
project" under one amber swatch. Later, a scheduled evaluation's grey pill
read as a draft's (#786), and a dated draft read as scheduled (#857, #921).

## Decision

### The grammar

| Tone, face | Meaning | Evaluation state | Project phase (§5) |
| --- | --- | --- | --- |
| Green, soft | Open to the students | `running` | `published` |
| Amber, soft | The staff's own correction or publication is awaited | `lobby`, `paused`, `grading` | `graded` |
| Blue (`info`), soft | Scheduled: ready, it opens on its own at a known time | `scheduled` | `scheduled` |
| Zinc, soft | At rest | `draft`, `closed` | `draft`, `locked`, `deadline_passed` |
| Green, outline | Finished, nothing awaited | `released` | `released` |

Words (`eval.state.*`, `project.state.*`, both languages): a project's
`graded` / `released` read "graded" / "released", « corrigé » / « rendu »,
never « publié », which already names a published project; `scheduled`
« planifié »; `deadline_passed` "deadline passed" / « échéance passée ». A
dated evaluation draft reads "draft · not scheduled" / « brouillon · non
planifiée » (§7).

1. **One grammar, for staff surfaces only**, the table above. One table per
   kind holds the tone and the face together (`STATE_STYLE` / `stateStyle`
   in `evaluation/common.ts`, `PHASE_STYLE` / `projectPhaseStyle` in
   `project/common.ts`, keyed by the phase of §5); `KIND` in
   `activities/model.ts` reads them, no view branches on a state's colour,
   and these two tables are the only place a state meets its colour. Blue is
   the `info` tone of `packages/ui`'s `badge` (`blue` in `apps/web`'s
   `Tone`). **A pill is never the accent**: the brand red belongs to the
   screen's one primary action (invariant 2 of `CLAUDE.md`). A future kind of
   activity declares its tone, its face and its timer deadline in its `KIND`
   entry and inherits every surface.
2. **An outline face of the badge**, in `packages/ui` (`badge(tone, extra,
   "outline")`, `variant="outline"` on `Badge`): no fill, the tone's ink, a
   1 px inset ring in the same colour (`ring-current`), for every tone. No
   solid-fill variant: the soft green plus the timer is what marks a live
   row, and a solid pill would compete with the row's one primary action.
   **Nothing blinks**: motion pulls the eye from that action too.
3. **The timer** — a `Timer` glyph and the time left (`TimeLeft` in
   `ui/dates.tsx`) — rides inside the badge in exactly two places: the
   evaluations list and the Projects group of a classroom's Activities tab,
   and only while the students are in (`running`, `published`; never a lobby
   or a pause, where nothing runs out). There **the timer replaces the
   word**: the pill shows the glyph and the time left, the state's word only
   as `sr-only` text ("running, closes in 2 d 4 h"). A live row with no
   deadline (an evaluation running without `closesAt`) has no timer and keeps
   its word: a pill is never empty. Everywhere else the badge wears the tone,
   the face and the word: the live header has the screen's one clock, the
   project page's clock is its rail (§8), `/activities` has its Closing
   column. The Projects table's Deadline cell keeps the absolute date only.
   - **Format: two units, floored.** From a day: days and hours ("2 d 5 h",
     fr "2 j 5 h"). Under a day: hours and minutes ("1 h 40 min", fr
     "1 h 40", the minutes on two digits as French writes a time). Under an
     hour: minutes ("35 min"). Under ten minutes: minutes and seconds
     ("9 min 32 s", "45 s"). A second unit that is zero is left out ("2 d",
     "3 h", "5 min"). Floored — a badge never promises more than what is
     left — and never negative: a deadline just passed (the +3 s grace of
     invariant 5, a project's lock within the minute) reads "0 s" until the
     state catches up. The same format serves every use of `TimeLeft`.
   - **Ticking.** `TimeLeft` ticks on the shared minute timer of `useNow`,
     and on the shared second timer only while under ten minutes and before
     the deadline, so a list does not re-render every second for deadlines
     days away; a timer armed for the ten-minute mark switches at that exact
     moment.
   - **Not the other clocks.** The live header's countdown and the Super
     Powers banner keep `formatRemaining` (`ui/live.tsx`), a by-the-second
     countdown rounded up, which a screen with one clock to watch needs.
4. **The gantt's bar is derived from the badge's tone**: green and amber
   fill at full strength; three exceptions a badge does not draw stay
   explicit — a dashed outline for a draft, an info ring for a bar whose
   badge is blue (`KIND`'s `stateStyle`: a scheduled evaluation or project),
   the recessed surface for everything over. The outline face never reaches a
   bar. The legend reads "open to students" and "waiting room, paused".
5. **A project's phase.** A project's stored state stops at `locked`, but
   behind it the staff must tell apart what an evaluation's `closed`,
   `grading` and `released` tell apart. The staff's project summaries and
   the project page carry a derived **phase** — `draft | scheduled |
   published | locked | deadline_passed | graded | released`
   (`projectPhase` of `@quiz/domain`, `ProjectPhase` of the contracts),
   never stored — and the badge reads it; the buckets, the sorting and the
   gantt keep reading the state.
   - `draft`, `scheduled` and `published` follow the state (the `scheduled`
     state of [ADR-127](ADR-127-etat-planifie-des-projets.md) §11, armed by
     Schedule); a draft holding a date is `draft`.
   - `locked` refines into `locked` (the scores are not final, `lock`
     strategy), `deadline_passed` (the same under the `commit` deadline
     strategy, F-PROJ-09, which locks nothing: never said "locked"),
     `graded` (final per `scoresFinal`, the staff's release awaited, as an
     evaluation's `grading`) and `released` (`releasedAt` set, as a released
     evaluation), the last two for both strategies. The project page's status
     line (`projectStatus`, `project/projectPage.ts`) says the deadline passed
     on its date, never "locked since", for a `deadline_passed` project, with
     the same freezing clause as a locked one.
   - Three choices of the product owner (2026-10-11): the state comes first,
     so a project moved back to `published` by a later deadline is
     `published` even with its `releasedAt` kept (F-PROJ-09); a released
     project whose scores changed since stays `released` on the list — the
     page's primary action already says a re-release waits, and
     `changedAfterRelease` is not computed for a list; a project graded
     `none` never has final scores, so it stays `locked` after its deadline.
   - The list stays cheap (F-PROJ-13): the counts behind the phase come from
     one query, one row per live student repository of the locked projects
     listed, their slot runs joined, no GitHub call and no project detail
     loaded.
   - The student's surfaces follow the same rule for one repository, under
     their own grammar: past its effective deadline, a repository GitHub does
     not hold locked is never said locked (`deadline_passed` of
     `studentProjectStatus`, `@quiz/domain`).
6. **A new pill tone needs a meaning of its own.** A pill tone joins this
   grammar only for a meaning distinct from the ones it holds, and only by an
   amendment of this record that names it, with its tokens readable at 4.5:1
   in both themes and its entry in the two tone tables of §1.
7. **A dated draft is never blue**: blue is a promise that it opens on its
   own, and an evaluation opens by itself only once Launch's Schedule made it
   `scheduled` (the ticker's `live.open_scheduled` opens nothing else, F-EVAL-04);
   a project likewise (ADR-127).
   - The zinc pill of an evaluation draft on the Scheduled clock (ADR-086)
     with its `opensAt` set reads "draft · not scheduled"
     (`evaluationBadgeLabel` in `evaluation/common.ts`, from the `clock` the
     lists carry), everywhere the badge and the gantt's label are drawn; a
     Live draft's date is a calendar hint and keeps "draft".
   - **The configuration says what happened.** `schedulingPhase`
     (`evaluation/common.ts`, over the domain's `isUnscheduledDraft`) tells a
     draft to schedule, one that missed its opening and one whose end has
     passed too. The steps before Launch show one neutral `Alert` per phase,
     with the date and a pointer to Launch in words but no button, so Launch's
     Schedule stays the one primary action; Launch's status line follows the
     phase, and its primary opens it now. Scheduling at a past date stays
     refused (`opens_at_past`).
   - **A draft's window is never stated as a fact**: the Format summary and
     Launch's timing check word it conditionally, by the clock. The Format
     step's mode card is "Automatic" / « Automatique » and says it opens by
     itself once scheduled in Launch; the state and the action keep their
     words.
   - **The MCP says it**: `update_evaluation` returns the evaluation's `url`,
     plus a `notice` for a dated draft on the Scheduled clock; no MCP tool
     schedules or opens anything.
8. **The project rail carries the project page's one clock.** While a
   project is `published` and the server has not applied its deadline
   (`deadlinePassed`, the server's word — invariant 5), the lifecycle rail
   (`ProjectRail`) fills its line from Published toward the Deadline in
   proportion to the time elapsed from the publication to the deadline
   (clamped 0..100 %), and writes the time left under the deadline's date
   through `TimeLeft` (§3's format, no new clock). Each segment between two
   markers fills by its own two dates, since the markers are evenly spaced;
   the value given to a screen reader is the overall fraction. The bar and
   the figure wear the **accent**: they are not a control, so not a second
   primary action, and with the accent stripped the rail still reads. Two
   countdowns of one deadline on one page are refused, so the Deadline tile
   (`ProjectOverview`) has no relative line while the rail carries the time
   left, and says "passed" once the server applied the deadline. After the
   deadline the rail is the plain one: no bar, no time left.
9. **The start in sight.** The evaluations table of a classroom's Activities
   tab has a Start column — when it started (`startedAt`; an evaluation
   opened by hand has no `opensAt`), else when it is to open (`opensAt`), as
   an absolute date and time, a dash when neither is set — then an End
   column (`closesAt`), as the Projects table has Start and Deadline. A row
   without a date sorts last in either direction. `/activities` files a
   scheduled project under Current beside a scheduled evaluation (`tabOf`,
   `isScheduled`, which the "Scheduled" filters also read), so its start and
   deadline count in the "Next 7 days" tile, `nextEventOf` and the classroom
   list's next event (`course/classroomSignals.ts`).

## Consequences

- A published project is green, not amber, on every staff surface and on
  the gantt — the reversal of M3-10, which had read amber as "open but nobody
  is in the room"; openness, not presence, is what the colour says. A
  released evaluation is outline green, not soft green.
- The time left left the Projects table's Deadline cell for the badge — the
  reversal of M3-14a finding no. 6, with a live tick that finding had
  declined.
- `phase` joins `state` on `ProjectActivitySummary` and `ProjectDetail`,
  staff contracts both; no student contract or view gains it (invariant 4 of
  `CLAUDE.md`). A locked project's row costs the list one query over its
  repositories and their slot runs; a draft or a published one costs nothing
  more.
- The student's cards are untouched: their amber still means "a step waits
  on the student", a rule of their own that `DESIGN.md` keeps beside this
  one.

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
- **A blinking running badge** (#786). Declined (§2).
- **The time left in its largest unit only** ("1 h" with 1 h 40 min left,
  #794). Replaced by two units (§3).
- **The word beside the timer** ("running ⏱ 2 d 4 h"). Replaced by the timer
  alone (§3): the soft green and the clock already say "open, closes in".
- **After the deadline, completing the rail's segment in a neutral ink.** Set
  aside as one more mark saying the same thing (§8).

## Correspondence of old references

Code and `apps/web/DESIGN.md` cite the amendments by date. Their full text is
the [historical record](history/ADR-104-badges-d-etat-unifies.md); a citation
now lives here:

<a id="amendment-2026-10-13-the-project-rail-carries-its-own-clock"></a><a id="amendment-2026-10-13-blue-for-what-is-scheduled-and-the-rule-for-a-new-pill-tone"></a><a id="amendment-2026-10-13-the-time-left-in-two-units"></a><a id="amendment-2026-10-14-the-timer-replaces-the-word"></a><a id="amendment-2026-10-14-a-dated-draft-is-not-scheduled"></a><a id="amendment-2026-10-26-a-dated-draft-whose-opening-passed"></a><a id="amendment-2026-10-29-a-deadline-that-locks-nothing-is-not-locked"></a>

| Old reference | Current section |
| --- | --- |
| §1–§5 | [The grammar](#the-grammar), same numbers |
| Amendment 2026-10-13 (#798), the project rail's clock | §8 |
| Amendment 2026-10-13 (#786, #795), blue for scheduled: items 1 and 3 | The table, §1 and §4; `/activities` filing: §9 |
| Same, item 2 (a project's `scheduled` phase) | §5, as amended by ADR-127 |
| Same, item 4 (Start column) | §9 |
| Same, item 5 (nothing blinks) | §2 |
| Same, item 6 (a new pill tone) | §6 and §1 (never the accent) |
| Amendment 2026-10-13 (#794), two units | §3, Format and Ticking |
| Amendment 2026-10-14, the timer replaces the word | §3 |
| Amendment 2026-10-14 (#857), a dated draft is not scheduled | §7 |
| Amendment 2026-10-26 (#921), a dated draft whose opening passed | §7 |
| Amendment 2026-10-29 (#958), `deadline_passed` | §5 |
| ADR-127 amendment (2026-11-06) | §5 and §7 |
