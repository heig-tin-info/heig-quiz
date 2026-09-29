# ADR-041 — The drill: spaced practice, scheduled by FSRS, rated by correctness and time

## Status

Accepted (2026-09-29). §1 to §4, the opt-in of §6, and §7 to §8 record the
decisions of the product owner in issue #317 (first decision comment). §5
(FSRS-5, default weights, target retention 0.9, `ts-fsrs`) and the session
composition of §6 adopt the issue's own proposals (body, §2 and §3), which
that comment did not decide; the implementation details of §5 are this
ADR's. §10 records the second round of decisions (issue #317, last
comment, 2026-09-29): the product owner accepted every proposal this ADR
had listed as "to be confirmed", one of them changed, and settled question
28 of docs/spec/06; §13 records the third round (the review of slice 2).
Slice 1 of #317 implements the pure rules in
`@quiz/domain`, with the `ts-fsrs` dependency; slice 2 the `drill` module.
Amends F-DRILL-01 to F-DRILL-04 and adds F-DRILL-06 (docs/spec/02); amends
N-DATA-02, N-DATA-03 and N-DATA-07 (docs/spec/03), the question-type
contract (docs/spec/04 §4.1) and the drill tables (docs/spec/05 §5.4).

## Context

The spec reserved a phase-2 drill in five lines: every question a student
meets becomes a card, FSRS schedules it, the teacher sees aggregates only.
Issue #317 made it a product: a daily practice of about ten minutes, on a
phone or a computer, over the questions of the student's evaluations of the
year, where a question often failed comes back sooner and an old one comes
back now and then.

Four facts shape it: an exam question drilled before the release would leak
its grade; a teacher may not want reused exam questions practised forever;
the same question takes longer on a phone, and time is part of mastery; and
re-tuning the scheduler later needs a history, which is personal data.

## Decision

### 1. When a question becomes a card

A card is one per student and question. It is created at the **release of
an exam's results**, never before, and at the **hand-in of an exercise**.

### 2. "Allow drill", per evaluation

An evaluation setting: **on by default for an exercise, off by default for
an exam**, where the teacher chooses at creation.

### 3. The types of v1

`mcq`, `short`, `cloze`, `categorize`. `rich` and `circuit` are out; `code`
and `codeimage` come later, through the browser runner, on a computer only.
Within that scope, a question takes a card only when the type grades its
answer **automatically and finally** — graded at once, not pending a runner
or an LLM, not a proposal for the teacher. A review has nobody to wait for.

### 4. The rating: strategy A, correctness and time

| Correctness | Active time `t` against the reference `ref` | Rating |
|---|---|---|
| wrong or empty | any | 1 Again |
| partial | any | 2 Hard |
| right | `t > 1.5 × ref` | 2 Hard |
| right | `0.6 × ref < t ≤ 1.5 × ref` | 3 Good |
| right | `t ≤ 0.6 × ref` | 4 Easy |

- **Correctness** comes from the type's ordinary `grade`: every point is
  right, none (or a negative score, ADR-026) is wrong, the rest partial.
- **The time is active**: the clock pauses while the tab is hidden. It is
  summed by the server from what the client reports on screen, as ADR-039
  does, with the same idle cap (`DWELL_IDLE_CAP_MS`) — never taken from the
  browser (invariant 5).
- **The reference** is the median time of the correct answers on the
  question, on the **same device class**, once about ten exist; before that,
  the student's own previous time; failing that, an estimate per type.
- **The device class** (`coarse` / `fine` pointer) is recorded on each
  review; times are compared only within one class.
- Strategy C (a proposed rating the student moves by one step) may come
  later.

### 5. The scheduler

**FSRS-5, default weights, target retention 0.9**, through the `ts-fsrs`
library (MIT, no dependency, ESM), wrapped so that no type of it leaves
`packages/domain`. `ts-fsrs` 5 implements FSRS-6; it is given FSRS-5's 19
weights plus the two values that make FSRS-6 compute FSRS-5 exactly. Only
the long-term scheduler is used — no learning steps, since a drill reviews a
card at most once a day — and no fuzz, so a review is deterministic.

The web app imports `@quiz/domain`; a web build with the scheduler in the
package's index carried part of the library, so the scheduler is reached by
its own subpath, `@quiz/domain/drillSchedule`, and the index does not
re-export it. The web build then contains none of it.

### 6. Opt-in and the session

- The **teacher enables** the drill for a classroom; its students are **in
  by default and may opt out**.
- A session holds the **due cards first**, the lowest retrievability ahead,
  then **new cards capped per day**, until a **time budget of about ten
  minutes** counted from the cards' reference times; it may end early.
  Courses and tags are **interleaved**, not in blocks.
- **No reminders and no streaks in v1**: a "today's drill is available"
  badge on the home and on the centre slot of the bottom bar.

### 7. Question edits

A question edited after its card exists keeps the card's FSRS state, unless
its **answer key changed**: then the card is reset.

### 8. Data

This deliberately **amends F-DRILL-04** ("never the individual detail by
default"):

- **Retention: five years** for a student's drill data — three years of
  studies, four part-time, one repeated.
- **The teacher sees each student's individual activity** — whether they
  practise (questions seen, sessions) and a measure of improvement over
  time. No minimum group size applies to this per-student view: the product
  owner chose individual visibility.
- **The student is told** in the drill tab that their teacher sees this
  activity; the data-protection page (N-DATA-07, #274) says so too.

### 9. The invariants the drill keeps

- **Invariant 4.** A drill question reaches the student only through the
  `studentView` service (`toStudent`), and its key only through
  `studentSolutionView`, like any attempt's.
- **Invariant 5.** Review times and due dates are the server's.
- **Invariant 6.** The teacher's per-student view is loaded through
  `staffAccess` on the classroom; otherwise a 404.

### 10. Second round (product owner, 2026-09-29)

Every proposal of the first version of this ADR is accepted; item 3 is
changed.

1. A card enters as **new**: the evaluation's answer is not its first review
   (its time was an exam's pace), and a later attempt of an exercise creates
   nothing.
2. A **poll creates no card**.
3. **Changed.** Turning "Allow drill" off keeps the cards already created,
   and the teacher has an explicit action, **"Remove these questions from
   the drill"**, which deletes the cards the evaluation gave rise to (and
   their reviews). The setting stays editable until the release, and is
   copied into and from templates (F-EVAL-18).
4. Opting out is **per classroom**, not global.
5. Only a grading that is **automatic and final** creates a card (§3): this
   excludes a `short` question with an `llm` matcher.
6. The `toDrillGrade` hook is **removed from the contract** (docs/spec/04
   §4.1) in favour of the common eligibility rule: strategy A needs
   correctness, and correctness is the same function of the points for the
   four v1 types. A later type may bring a hook back.
7. A right answer with **no reference time** at all is rated **Good**; a
   card with no reference time counts a fixed fallback in the session
   budget.
8. **Progress** is shown to the teacher as activity (questions seen,
   sessions) beside the **recall rate on repeated reviews**, per time
   window: among the reviews of a question the student had already
   drilled, the share not rated Again. A question's first drill review is
   left out, since it measures the evaluation, not the practice. It is
   FSRS's "true retention": near the target when the schedule works,
   rising with progress.
9. At most **10 new cards per day**; a card longer than the whole budget is
   still served alone, so a session is never empty while a card is
   available. A per-classroom setting may come later.
10. **Mastery per tag, per classroom**, for the teacher.

Two more rules this ADR proposed are adopted with them:

- The answer-key change of §7 is detected by a **hash of the type's
  `toSolution` under a fixed view**, stored on the card.
- **Retention anchors:** a review is purged five years after it was made, a
  card five years after its last review (or its creation if never
  reviewed).

And the answers to question 28 of docs/spec/06, which bind the
implementation:

- **(a)** Deleting a classroom, an evaluation or a question deletes the
  drill data derived from it (N-DATA-03).
- **(b)** No extra practice in v1. An empty day says "nothing to review
  today" and gives the next due date.
- **(c)** One budget of ten minutes, every v1 type on both device classes.
- **(d)** No damping of Easy; the choices of an `mcq` are shuffled at each
  review.
- **(e)** A review is graded with the settings of the evaluation where the
  card was met first.
- **(f)** No whole-pool drill in v1.
- **(g)** A card leaves the session when its classroom is archived; its
  data is kept for the retention period.
- **(h)** A drill review always shows the key (`studentSolutionView`). **The
  "Allow drill" setting says so next to its switch**: students will see the
  key of these questions after each review.
- **(i)** A new seed at each review.
- **(j)** A card belongs to the classroom where it was met first, and only
  that classroom's staff see its reviews.
- **(k)** An opt-out hides the activity **from then on**: what was recorded
  before stays visible to the teacher, and **the opt-out confirmation tells
  the student so**.
- **(l)** No minimum group size within a classroom, since the per-student
  view is visible anyway. The 10-student threshold stays for
  cross-classroom or multi-year statistics (N-DATA-06).

The two sentences in bold under (h) and (k) are UI copy obligations of
slice 3 (the student's tab) and of the evaluation settings screen.

### 11. What the client can influence

The server owns every instant of a review (invariant 5), but two inputs come
from the browser:

- **The visibility reports** (`POST /drill/cards/:id/shown`). A client that
  reports the tab hidden while the student is thinking lowers the counted
  time; it can never raise it, since each interval ends at the server's
  instant of the next signal and is capped by `DWELL_IDLE_CAP_MS`.
- **The declared device class.** A student may claim `coarse` on a
  computer, to be compared with the slower phone times; like the reports,
  this can only make a time look shorter against its reference.

Both can turn a Good into an Easy. Before a question has ten correct times
on a device class, the reference is the student's own previous time, which
the same student produced. The damage is bounded by the serving rule: a
card is served and answered only when **today's session would hand it
out** — not reviewed yet today, and due before the day ends or new within
the day's cap — so a student cannot re-answer a card at once to forge a
rating or the recall rate, and there is no extra practice (06, question
28 (b)). Anything else is the 404 of a missing card.

### 12. Implementation choices of slice 2

- **The drill day is the Europe/Zurich calendar day** (`drillDayBounds`).
  A card is due today when it is due before the day ends: FSRS counts whole
  days from the last review, and a card due at 14:00 belongs to the
  morning's session. The cap of new cards resets at local midnight.
- **A new card held back by the cap is announced for tomorrow**: an empty
  day gives the start of the next day as its next due date.
- **Interleaving** groups the session by course and the question's first
  tag in alphabetical order.
- **A review is scored on the type's `defaultPoints`**, not the points the
  item had in its evaluation: correctness is a ratio, and a review has no
  item.
- **The review in progress lives on the card**: `serve_seed` (the seed of
  this review, null when none is served), `shown_since` (the open interval
  on screen) and `active_ms` (what was already credited), cleared by the
  answer.
- **Eligibility is a property of the question**, decided once, when the
  cards are created, from the type's grading of an empty answer under the
  evaluation's settings. A review whose grading is not final (an edit made
  the question wait for an LLM or a teacher) is refused and writes nothing;
  the card and its history stay.
- **The hooks go one way.** `results` (`onResultsReleased`) and `live`
  (`onAttemptsEnded`) call their listeners after the commit; the `drill`
  module registers them and neither module imports it.

### 13. Third round (product owner, 2026-09-29, review of slice 2)

Recorded in the last comment of issue #317; all accepted as recommended.

1. **Backfill on enabling.** When a teacher enables the drill for a
   classroom — the first time or again — cards are created for its past
   evaluations that allow the drill: the exams whose results are released,
   the exercises for every student who handed one in. Same path as at a
   release or a hand-in (`backfillClassroom`): the same eligibility, the
   first meeting wins, nothing twice.
2. **An exercise's key.** An exercise's card is served only once the
   exercise's own feedback policy shows the key to that student — the rule
   of the feedback page (`results.keyShownTo`) on the student's latest
   attempt: at the hand-in under immediate feedback with the key, at the
   release under `on_release`, never when the key is not shown. The drill
   never shows a key earlier than the exercise would. The card exists from
   the hand-in; the serving rule, not a due date, holds it back, so the
   session, the serve and the answer all refuse it alike.
3. **A withdrawn release.** An exam's cards are served only while its
   results are released. Withdrawn, they are suspended — not served, their
   history kept; the next release serves them again and creates only what
   is missing.
4. **The version served.** A review serves the latest published version of
   the question, so a corrected key reaches the drill. The consequence: an
   edit made for a future exam reaches the drill too, and a question reused
   in a future exam is practised, key included, by the students who met it.
   "Allow drill" is what controls that risk. **The note next to the "Allow
   drill" switch says so** (slice 3): students see the key after each
   review, and the latest version of the question is served.
5. **The opt-out is visible.** The teacher sees that, and when, a student
   opted out (slice 4's view, from `enrollments.drill_opted_out_at`).
   **The opt-out confirmation tells the student so** (slice 3), besides
   that their past activity stays visible (§10, (k)).
6. **Unanswered questions become cards.** Eligibility is a property of the
   question (§12), so a question the student left blank becomes a card like
   any other.

UI copy obligations of slice 3, together: the "Allow drill" note (the key
is shown after each review; the latest version is served) and the opt-out
confirmation (past activity stays visible; the teacher sees the opt-out).

### 14. Implementation choices of slice 3 (the screens)

- **The session starts on a button.** The drill page shows today's count
  and budget with one primary, Start; a card is served — its clock opened —
  only then, never on opening the page. The list is taken as it was at
  Start and walked on the client: the session re-read after each answer
  would drop the card just answered, so it is read again only at the end.
- **One card at a time, through the type's own player** (`QuestionHost`,
  the attempt's), then its own `Review` for the key (`QuestionReviewHost`,
  the feedback page's). The one button reads Check, or "Show the answer"
  while nothing is written: an empty answer is a review, rated Again.
- **The visibility reports** are a hidden report when the tab hides, a
  shown one when it returns, and a hidden one when the page is left with
  the card unanswered. A report that fails is dropped, since it can only
  lower the time counted (§11).
- **A card that cannot be served** (its classroom archived since the
  session was read, say) offers a retry and "Skip it"; the summary counts
  the reviews only.
- **The next review** is said in calendar days ("tomorrow", "in 4 days"),
  the empty day's next due date as a date.
- **Opting back in takes no confirmation**; opting out is confirmed, with
  the two sentences of §10 (k) and §13 item 5, and is not styled as
  destructive — nothing is deleted.
- **The badge is a dot, never a count** (DESIGN.md, "The student's bottom
  bar"): on the Drill slot, on the sidebar's Drill row, and an "available"
  badge on the home's card for today's drill. Slot and row are drawn only
  for a student with a classroom whose drill is on.
- **The teacher's switches.** The classroom's sits on its Evaluations tab,
  under the list, and says how many cards the backfill made. "Allow drill"
  sits in the evaluation's second step, its note always shown, on or off;
  the removal is a secondary button in the same card, offered while there
  are cards, confirmed as destructive with their count. The count is read
  from `GET /evaluations/:id/drill` (`EvaluationDrill`), the one read added
  to the module for it: the evaluation's detail does not carry it.

### 15. Implementation choices of slice 4 (the teacher's view)

- **Three reads, loaded through `staffAccess` on the classroom**:
  `GET /classrooms/:id/drill/activity` (one row per student seat),
  `GET /classrooms/:id/drill/progress?student=` (the weeks of one seat,
  an enrollment id, or of the whole classroom without it) and
  `GET /classrooms/:id/drill/mastery` (per tag). Each is a bounded number
  of queries whatever the class size.
- **The recall rate** of §10 item 8 is defined once, in `@quiz/domain`
  (`drillRecallCounts`): a card's first review is decided over its whole
  history, before a window or an opt-out cuts it. The SQL aggregates the
  same thing with a window function, and the database test holds the two
  to the same numbers. The API answers counts (`repeated`, `recalled`),
  never a ratio, so "no repeated review" is not 0 %.
- **Windows are rolling** from the server's now: 7 and 30 days, and all.
  The **trend** compares the last 30 days with the 30 before, only when
  each holds at least 5 repeated reviews, and reads flat within 5 points.
- **Sessions are Europe/Zurich days** with a review, the drill's day
  (§12). **Weeks** run Monday to Sunday on the same clock, over the
  classroom's dated period cut at today, or, without one, from the week
  the drill was enabled (or the first review, if earlier); empty weeks
  are included and at most 104 are drawn.
- **After an opt-out**, a review is not counted in any read (28 (k)); the
  opt-out's date is on the row (§13 item 5). **Mastery** reads each card's
  current state, the retrievability now of FSRS: an opted-out student's
  cards hold their state from before, and count.
- **Only the classroom's current student seats** are listed; a card of a
  student no longer on the roster is not counted.
- **The screen** is a third tab of the classroom, **Drill**, which also
  takes the classroom's drill switch from the Evaluations tab (§14): off,
  the tab is an empty state above the switch. The per-student progression
  opens in a sheet, as two small charts over the same weeks (no second
  axis): reviews as bars, the recall rate as a line with the 90 % target.
  The page header has no primary action on this tab.

## Consequences

- The domain rules exist before any table; slice 2 wires them to the
  `drill` module.
- `@quiz/domain` has its first third-party dependency, server-side only.
- Early ratings lean on the student's own time or a type estimate, until a
  question has enough correct answers on a device class.
- Five years of reviews per student: small rows, well within one database.
- The teacher's view is individual; the tab's notice and the data page are
  part of the feature.

### Rollback

Slice 1 is additive and unused until slice 2: removing its files and the
dependency restores the package.

## Alternatives considered

- **Self-rating (strategy B).** One more tap per card, and easily gamed.
- **A fixed number of questions per session.** Ten `mcq` and ten `cloze`
  are not the same effort; a time budget is.
- **Aggregates only for the teacher (F-DRILL-04 as written).** The product
  owner wants to see who practises and who progresses; the student is told.
- **A port of FSRS-5 into the package.** Some hundred lines of our own to
  keep in step with the reference implementation that re-optimising the
  weights will use.
- **FSRS-6 default weights.** Newer; switching is one array once the
  weights are re-optimised on our own reviews.

## Left open

Nothing of question 28 (settled in §10). A per-classroom cap on new cards,
a configurable budget (F-ADMIN-03) and strategy C remain later work.
