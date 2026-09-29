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
28 of docs/spec/06. Slice 1 of #317 implements the pure rules in
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
