# ADR-041 — The drill: spaced practice, scheduled by FSRS, rated by correctness and time

## Status

Accepted (2026-09-29, issue #317): §1–§4, the opt-in of §6 and §7–§8 are the product owner's first
decision comment; §5 (FSRS-5, default weights, retention 0.9, `ts-fsrs`) and §6's session composition
adopt the issue's own proposals (body, §2 and §3) that comment did not decide; §5's implementation
details are this ADR's. Folded on 2026-10-09: the product owner's second round (former §10, 2026-09-29,
issue #317, last comment: every "to be confirmed" proposal accepted, one changed; question 28 of
docs/spec/06 settled) and third round (former §13, 2026-09-29, issue #317, last comment, review of
slice 2, all accepted as recommended).

Relations: amends F-DRILL-01 to F-DRILL-04 and adds F-DRILL-06 (docs/spec/02);
amends N-DATA-02, N-DATA-03 and N-DATA-07 (docs/spec/03), the question-type
contract (docs/spec/04 §4.1) and the drill tables (docs/spec/05 §5.4). Amended
by [ADR-050](ADR-050-publier-la-correction-d-un-exercice.md) (2026-09-30, the
exercise's key in §1), [ADR-056](ADR-056-questions-parametrees.md) §5
(parameterized reviews store their drawn values) and the
[third addendum of ADR-081](ADR-081-vocabulaire-de-notions.md#third-addendum-2026-10-08-the-cut-over)
§8 (concepts replace tags in §6's and §12's interleaving and §8's and §15's
mastery, past reviews regrouped under today's classification); extended by
[ADR-085](ADR-085-confiance-dans-l-entrainement.md): a review stores the
confidence the student stated, which §4 and §5 never read; since ADR-085 §4's
amendment of 2026-10-08, the due date §5 computes is capped to the next day for a
confident error, FSRS's state untouched (§11).

Extended by [ADR-103](ADR-103-type-blocs.md) §10 (2026-10-11): `blocks` joins
the types of §3.

Student mastery per concept (F-DRILL-05) is decided in
[ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md), which keeps §6, §11 and §15.

Amended 2026-10-09: the Rollback section is removed (the
[deployment runbook](../development/deployment.md) owns recovery; its rule on
student history is a Consequence); §15 places the classroom's drill switch in the
classroom's Settings (`ClassroomSettings.tsx`), not in the Drill tab (the
[historical record](history/ADR-041-entrainement-espace.md)'s §14 says where it
sat first); §11's "two inputs come from the browser"
reads "these inputs", since the section lists three (the third, the stated
confidence, came with ADR-085).

Amended 2026-10-14 (product owner): the course's staff — owners and
assistants — also see WHEN the classroom's students practise, as a weekday ×
hour heatmap of the last 30 days, for the class and for one student (§8, §15).
The drill is a declared teaching activity whose reviews the student is told
their teacher sees; platform presence (ADR-107) is not, and stays aggregated
for the administrator only.

Amended 2026-10-15 (§8's "The student is told" only, issue #868): the
data-protection page it names is the "Data and privacy" page of N-DATA-07
(`/privacy`); it says that the teacher sees the drill activity, at what times
of the week included.

Amended 2026-10-15 by [ADR-115](ADR-115-revision-ciblee-par-notion.md)
(product owner, #897 step E): extra practice exists as **targeted revision by
concept**, on its own routes and tables, outside FSRS, the level and every read
of the daily reviews; a card served in one of its rounds today leaves today's
session (§2, §5, §6, §7, §8, §11, §12, §14, Consequences: settled question
28 (b)).

Amended 2026-10-27 (product owner; §6, §11 and §12 only): the cap of new
cards per day is a default, not a ceiling. A student whose session is empty
while new cards wait beyond the cap may let in the next batch of
`DRILL_NEW_PER_DAY` for the rest of the day, as often as they like; these are
real first reviews. An empty day with no new card waiting leads to targeted
revision ([ADR-115](ADR-115-revision-ciblee-par-notion.md) §13). Cards not
yet due are never reviewed early, and the badge is unchanged. Case: a
student met the cap two days in a row with 21 new cards waiting, after five
series of exercises created 41 cards at once, and saw "Nothing to review
today" with no action.

Amended 2026-11-02 by [ADR-124](ADR-124-un-exercice-montre-toujours-sa-correction.md): §1, the exercise's key only — an exercise shows its key at every hand-in, so its card is served once the student's latest attempt is handed in (`keyShownTo`, unchanged as the rule; held back again while a retake is written). The stored policy no longer holds it back.

Consolidated 2026-11-08, no decision changed: §12, §14 and §15, the
implementation choices of slices 2, 3 and 4, are reduced to the rules still in
force; their full text is in the
[historical record](history/ADR-041-entrainement-espace.md).

## Context

The spec reserved a phase-2 drill in five lines: every question a student meets
becomes a card, FSRS schedules it, the teacher sees aggregates only. Issue #317
made it a product: a daily practice of about ten minutes, on a phone or a
computer, over the questions of the student's evaluations of the year, where a
question often failed comes back sooner and an old one comes back now and then.

Four facts shape it: an exam question drilled before the release would leak its
grade; a teacher may not want reused exam questions practised forever; the same
question takes longer on a phone, and time is part of mastery; and re-tuning the
scheduler later needs a history, which is personal data.

## Decision

The product owner's second and third rounds, formerly §10 and §13, are folded
below, each item marked with its round. **The numbering skips §10 and §13 on
purpose**: code and other records cite §11, §12, §14 and §15 by number, so the
sections keep their numbers and the two folded ones are not reused; the
[correspondence table](#correspondence-of-old-references) maps every old item.

### 1. When a question becomes a card

- A card is one per student and question. It is created at the **release of an
  exam's results**, never before, and at the **hand-in of an exercise**.
- A card enters as **new**: the evaluation's answer is not its first review (its
  time was an exam's pace), and a later attempt of an exercise creates nothing.
  A **poll creates no card**. *(Second round.)*
- A card belongs to the classroom where it was met first, and only that
  classroom's staff see its reviews. *(Second round, 28 (j).)*
- **Backfill on enabling.** When a teacher enables the drill for a classroom —
  the first time or again — cards are created for its past evaluations that
  allow the drill: the exams whose results are released, the exercises for
  every student who handed one in. Same path as at a release or a hand-in
  (`backfillClassroom`): the same eligibility, the first meeting wins, nothing
  twice. *(Third round.)*
- **An exercise's key.** An exercise's card is served only once the exercise's
  own feedback policy shows the key to that student — the rule of the feedback
  page (`results.keyShownTo`) on the student's latest attempt: at the hand-in
  under immediate feedback with the key, at the release under `on_release`,
  never when the key is not shown. The drill never shows a key earlier than the
  exercise would. The card exists from the hand-in; the serving rule, not a due
  date, holds it back, so the session, the serve and the answer all refuse it
  alike. *(Third round.)* *Amended by ADR-050 (2026-09-30): `keyShownTo` counts a
  correction the teacher published while the exercise runs as the release, so
  under `showKey` the cards are served from the publication on — held back again
  while the student's latest attempt is being written. No drill rule changed;
  the drill follows the feedback page by construction.*
- **A withdrawn release.** An exam's cards are served only while its results are
  released. Withdrawn, they are suspended — not served, their history kept; the
  next release serves them again and creates only what is missing. *(Third
  round.)*

### 2. "Allow drill", per evaluation

- An evaluation setting: **on by default for an exercise, off by default for an
  exam**, where the teacher chooses at creation.
- **Changed in the second round.** Turning "Allow drill" off keeps the cards
  already created, and the teacher has an explicit action, **"Remove these
  questions from the drill"**, which deletes the cards the evaluation gave rise
  to (and their reviews). The setting stays editable until the release, and is
  copied into and from templates (F-EVAL-18).
- A drill review always shows the key (`studentSolutionView`). **The "Allow
  drill" setting says so next to its switch**: students will see the key of
  these questions after each review. *(Second round, 28 (h).)* *Amended by
  ADR-115 §5, §13: a round of targeted revision shows the key after each answer
  too, and the note also says that students may revise these questions by
  concept.*

### 3. The types of v1

- `mcq`, `short`, `cloze`, `categorize`. `rich` and `circuit` are out; `code`
  and `codeimage` come later, through the browser runner, on a computer only.
- Within that scope, a question takes a card only when the type grades its
  answer **automatically and finally** — graded at once, not pending a runner
  or an LLM, not a proposal for the teacher. A review has nobody to wait for.
  This excludes a `short` question with an `llm` matcher. *(Second round.)*
- The `toDrillGrade` hook is **removed from the contract** (docs/spec/04 §4.1)
  in favour of the common eligibility rule: strategy A needs correctness, and
  correctness is the same function of the points for the four v1 types. A later
  type may bring a hook back. *(Second round.)*
- A question the student left blank becomes a card like any other, since
  eligibility is a property of the question (§12). *(Third round.)*

### 4. The rating: strategy A, correctness and time

| Correctness | Active time `t` against the reference `ref` | Rating |
|---|---|---|
| wrong or empty | any | 1 Again |
| partial | any | 2 Hard |
| right | `t > 1.5 × ref` | 2 Hard |
| right | `0.6 × ref < t ≤ 1.5 × ref` | 3 Good |
| right | `t ≤ 0.6 × ref` | 4 Easy |

- **Correctness** comes from the type's ordinary `grade`: every point is right,
  none (or a negative score, ADR-026) is wrong, the rest partial.
- **The time is active**: the clock pauses while the tab is hidden. It is summed
  by the server from what the client reports on screen, as ADR-039 does, with
  the same idle cap (`DWELL_IDLE_CAP_MS`) — never taken from the browser
  (invariant 5).
- **The reference** is the median time of the correct answers on the question,
  on the **same device class**, once about ten exist; before that, the student's
  own previous time; failing that, an estimate per type. A right answer with
  **no reference time** at all is rated **Good**; a card with no reference time
  counts a fixed fallback in the session budget. *(Second round.)*
- **The device class** (`coarse` / `fine` pointer) is recorded on each review;
  times are compared only within one class.
- No damping of Easy; the choices of an `mcq` are shuffled at each review. A new
  seed at each review. A review is graded with the settings of the evaluation
  where the card was met first. *(Second round, 28 (d), (i), (e).)*
- Strategy C (a proposed rating the student moves by one step) may come later.

### 5. The scheduler

**FSRS-5, default weights, target retention 0.9**, through the `ts-fsrs`
library (MIT, no dependency, ESM), wrapped so that no type of it leaves
`packages/domain`. `ts-fsrs` 5 implements FSRS-6; it is given FSRS-5's 19
weights plus the two values that make FSRS-6 compute FSRS-5 exactly. Only the
long-term scheduler is used — no learning steps, since a drill reviews a card at
most once a day — and no fuzz, so a review is deterministic. *Amended by
ADR-115 §1, §6: a round of targeted revision is not a review and never reaches
the scheduler; its relearning step (a wrong answer back once in the round) is
its own, not FSRS's.*

The web app imports `@quiz/domain`; a web build with the scheduler in the
package's index carried part of the library, so the scheduler is reached by its
own subpath, `@quiz/domain/drillSchedule`, and the index does not re-export it.
The web build then contains none of it.

### 6. Opt-in and the session

- The **teacher enables** the drill for a classroom; its students are **in by
  default and may opt out**. Opting out is **per classroom**, not global.
  *(Second round.)*
- A session holds the **due cards first**, the lowest retrievability ahead, then
  **new cards capped per day**, until a **time budget of about ten minutes**
  counted from the cards' reference times; it may end early. Courses and tags
  are **interleaved**, not in blocks (concepts since the ADR-081 cut-over).
- At most **10 new cards per day**; a card longer than the whole budget is still
  served alone, so a session is never empty while a card is available. A
  per-classroom setting may come later. One budget of ten minutes, every v1 type
  on both device classes. *(Second round, item 9 and 28 (c).)*
- No extra practice and no whole-pool drill in v1. An empty day says "nothing
  to review today" and gives the next due date. *(Second round, 28 (b), (f).)*
  *Amended by ADR-115 (2026-10-15): extra practice is targeted revision by
  concept, on the student's own cards, outside FSRS and the level; the empty
  day is unchanged, and there is still no whole-pool drill. A card served in a
  round today is not in today's session (ADR-115 §7).*
  *Amended 2026-10-27 (product owner):* the cap is where a day's new cards
  stop by default. When the session is empty and new cards are held back by
  it, the empty day's one action lets in the next batch of 10 for the rest
  of the day ("Add 10 new questions"; the session reloads with them), real
  first reviews rated and scheduled like any other; no ceiling on the
  batches, each session keeping its budget. The session reports the count
  held back (`heldNew`). With nothing held back, the empty day's one action
  is "Practise anyway", targeted revision (ADR-115) in the first of the
  student's drill classrooms, in the tab's order, where it is open to them
  and offers a concept; open nowhere, the empty day keeps its date alone. A
  card not yet due is never reviewed early, and the badge counts as before.
- A card leaves the session when its classroom is archived; its data is kept
  for the retention period. *(Second round, 28 (g).)*
- An opt-out hides the activity **from then on**: what was recorded before stays
  visible to the teacher, and **the opt-out confirmation tells the student so**.
  *(Second round, 28 (k).)* **The opt-out is visible**: the teacher sees that,
  and when, a student opted out (slice 4's view, from
  `enrollments.drill_opted_out_at`), and **the opt-out confirmation tells the
  student so** (slice 3), besides that their past activity stays visible.
  *(Third round.)*
- **No reminders and no streaks in v1**: a "today's drill is available" badge on
  the home and on the centre slot of the bottom bar.

### 7. Question edits

- A question edited after its card exists keeps the card's FSRS state, unless
  its **answer key changed**: then the card is reset. The change is detected by
  a **hash of the type's `toSolution` under a fixed view**, stored on the card.
  *(Second round.)*
- **The version served.** A review serves the latest published version of the
  question, so a corrected key reaches the drill. The consequence: an edit made
  for a future exam reaches the drill too, and a question reused in a future
  exam is practised, key included, by the students who met it. "Allow drill" is
  what controls that risk. **The note next to the "Allow drill" switch says so**
  (slice 3): students see the key after each review, and the latest version of
  the question is served. *(Third round.)* *Amended by ADR-115 §5: a round of
  targeted revision serves the latest version too.*

### 8. Data

This deliberately **amends F-DRILL-04** ("never the individual detail by
default"):

- **Retention: five years** for a student's drill data — three years of
  studies, four part-time, one repeated. **Retention anchors:** a review is
  purged five years after it was made, a card five years after its last review
  (or its creation if never reviewed). *(Second round.)*
- Deleting a classroom, an evaluation or a question deletes the drill data
  derived from it (N-DATA-03). *(Second round, 28 (a).)*
- **The teacher sees each student's individual activity** — whether they
  practise (questions seen, sessions) and a measure of improvement over time.
  No minimum group size applies to this per-student view: the product owner
  chose individual visibility. No minimum group size within a classroom either,
  since the per-student view is visible anyway; the 10-student threshold stays
  for cross-classroom or multi-year statistics (N-DATA-06). *(Second round,
  28 (l).)*
- **Progress** is shown to the teacher as activity (questions seen, sessions)
  beside the **recall rate on repeated reviews**, per time window: among the
  reviews of a question the student had already drilled, the share not rated
  Again. A question's first drill review is left out, since it measures the
  evaluation, not the practice. It is FSRS's "true retention": near the target
  when the schedule works, rising with progress. *(Second round, item 8.)*
- **Mastery per tag, per classroom**, for the teacher. *(Second round, item 10.)*
  *Amended by ADR-081 (third addendum §8):* per concept, labelled in the
  reader's language.
- **When students practise** *(amendment of 2026-10-14, product owner)*: the
  course's staff (owners and assistants) see at what hours of the week the
  classroom's students review, for the class (distinct students per slot) and
  for one student (their reviews per slot). It reads the drill's own reviews —
  a declared teaching activity, disclosed to the student by the notice below —
  never the platform's presence hours (ADR-107), which stay an administrator's
  aggregate that no staff screen reads. The same cuts apply as to every read
  of this view: the classroom's cards, its current student seats, nothing
  after an opt-out.
- **The student is told** in the drill tab that their teacher sees this
  activity, at what times of the week included; the data-protection page
  (N-DATA-07, #274) says so too.
- **Targeted revision** *(ADR-115 §8, §9, 2026-10-15)*: each round is recorded in
  its own tables, never in `drill_reviews`, kept five years from its start and
  deleted with its classroom; the staff see who revised which concept, as
  counts, under the same cuts (current student seats, nothing after an
  opt-out), and the student is told so.

### 9. The invariants the drill keeps

- **Invariant 4.** A drill question reaches the student only through the
  `studentView` service (`toStudent`), and its key only through
  `studentSolutionView`, like any attempt's.
- **Invariant 5.** Review times and due dates are the server's.
- **Invariant 6.** The teacher's per-student view is loaded through
  `staffAccess` on the classroom; otherwise a 404.

### 11. What the client can influence

The server owns every instant of a review (invariant 5), but these inputs come
from the browser:

- **The visibility reports** (`POST /drill/cards/:id/shown`). A client that
  reports the tab hidden while the student is thinking lowers the counted time;
  it can never raise it, since each interval ends at the server's instant of the
  next signal and is capped by `DWELL_IDLE_CAP_MS`.
- **The declared device class.** A student may claim `coarse` on a computer, to
  be compared with the slower phone times; like the reports, this can only make
  a time look shorter against its reference.
- **The stated confidence** (ADR-085, amended 2026-10-08). It reaches no rating
  and no FSRS state; it can only bring a confident error's due date earlier, to
  the next day at the latest.

The first two can turn a Good into an Easy. Before a question has ten correct
times on a device class, the reference is the student's own previous time, which
the same student produced. The damage is bounded by the serving rule: a card is
served and answered only when **today's session would hand it out** — not
reviewed yet today, and due before the day ends or new within the day's cap — so
a student cannot re-answer a card at once to forge a rating or the recall rate,
and there is no extra practice (06, question 28 (b)). Anything else is the 404
of a missing card.

*Amended 2026-10-27:* "new within the day's cap" reads "new within the
day's allowance": the cap, raised by `DRILL_NEW_PER_DAY` for each batch the
student unlocked today (§6), so each card still has its one review a day and
the rule above still closes every path to a forged rating. The unlock is a
compare-and-set on the count it read: a second click, or two requests at
once, unlock one batch.

*Amended by ADR-115 §1, §7 (2026-10-15):* the extra practice of targeted
revision runs on routes of its own that never write a review nor a card, so
the serving rule above still closes every path to a rating; and a card served
in a round today is not servable here today (`servableToday` refuses it), so
a key seen in a round cannot forge a daily rating. Its next daily review, from
the next day, may follow that key: an accepted bias.

§12, §14 and §15 keep, one line each, the rules still in force from the
implementation choices of slices 2, 3 and 4; their reasoning and the screens'
description are in the [historical record](history/ADR-041-entrainement-espace.md#12-implementation-choices-of-slice-2).

<a id="12-implementation-choices-of-slice-2"></a>

### 12. The drill day, the review in progress and the hooks

- The drill day is the Europe/Zurich calendar day (`drillDayBounds`): due today means due before it ends; the cap resets at local midnight (and bounds targeted revision, ADR-115 §5, §7).
- A new card held back by the cap makes the empty day announce the next day's start, with the count held back, `heldNew` (§6).
- Batches unlocked beyond the cap are a per-student counter for one drill day, `drill_new_unlocks`, read through `drillNewAllowed`; never a mark on the cards.
- Interleaving groups the session by course and the question's first concept id (ADR-081 third addendum §8).
- A review is scored on the type's `defaultPoints`, never the item's points.
- The review in progress lives on the card (`serve_seed`, `shown_since`, `active_ms`), cleared by the answer.
- Eligibility is decided once, at card creation, from the grading of an empty answer; a review whose grading is not final is refused and writes nothing.
- The hooks go one way: `results` and `live` call their listeners after the commit; the `drill` module registers them and neither imports it.

<a id="14-implementation-choices-of-slice-3-the-screens"></a>

### 14. The student's screens and the teacher's switches

- The session starts on Start, the page's one primary; a card is served, its clock opened, only then.
- One card at a time through the type's player (`QuestionHost`), then its review (`QuestionReviewHost`); an empty answer ("Show the answer") is a review, rated Again.
- Visibility reports: hidden when the tab hides or the page is left unanswered, shown when it returns; a failed report is dropped (§11).
- A card that cannot be served offers a retry and "Skip it"; the summary counts reviews only.
- Opting out is confirmed with the two sentences of §6, not styled as destructive; opting back in takes no confirmation.
- UI copy obligations: the "Allow drill" note (key after each review, §2; latest version served, §7) and the opt-out confirmation (§6).
- The badge is a dot, never a count, drawn only for a student with a classroom whose drill is on.
- The classroom's switch is a row of its Settings and states the cards the backfill made; "Allow drill" sits in the evaluation's second step, its note always shown; the removal is confirmed as destructive with its count.

<a id="15-implementation-choices-of-slice-4-the-teachers-view"></a>

### 15. The teacher's view

- Every read (activity, one seat's progress, mastery, hours) is loaded through `staffAccess` on the classroom, in a bounded number of queries.
- The recall rate of §8 is defined once (`drillRecallCounts`), a card's first review decided over its whole history; the API answers counts, never a ratio.
- Windows roll from the server's now (30 days, and all); the trend needs 5 repeated reviews in each 30-day window and reads flat within 5 points.
- Sessions are drill days with a review; weeks run Monday to Sunday over the classroom's period, empty weeks included, at most 104.
- The hours of the week (2026-10-14): the last 30 days by Europe/Zurich weekday and hour, distinct students per slot for the class, reviews for one student seat (any other seat is a 404); off-hours share as ADR-107 (`offHoursShare`).
- After an opt-out a review counts in no read; mastery reads each card's current FSRS retrievability, an opted-out student's cards included.
- Only the classroom's current student seats are listed or counted.
- No read filters deleted questions: the pool refuses to delete a question an evaluation holds, and deleting the evaluation cascades (28 (a)).
- The screen is the classroom's Drill tab, no primary action in its header; drill off, an empty state whose one action opens the Settings.

## Consequences

- The pure rules live in `@quiz/domain` (slice 1 of #317, with the `ts-fsrs`
  dependency); the `drill` module wires them (slice 2). `@quiz/domain` has its
  first third-party dependency, server-side only.
- Early ratings lean on the student's own time or a type estimate, until a
  question has enough correct answers on a device class.
- Five years of reviews per student: small rows, well within one database.
  Cards and reviews are student history, never disposable scheduler state.
- The teacher's view is individual; the tab's notice and the data page are part
  of the feature.
- Nothing of question 28 is left open; 28 (b) is amended by ADR-115 (extra
  practice as targeted revision, 2026-10-15). A per-classroom cap on new cards,
  a configurable budget (F-ADMIN-03) and strategy C remain later work.

## Alternatives considered

- **Self-rating (strategy B).** One more tap per card, and easily gamed.
- **A fixed number of questions per session.** Ten `mcq` and ten `cloze` are not
  the same effort; a time budget is.
- **Aggregates only for the teacher (F-DRILL-04 as written).** The product owner
  wants to see who practises and who progresses; the student is told.
- **A port of FSRS-5 into the package.** Some hundred lines of our own to keep
  in step with the reference implementation that re-optimising the weights will
  use.
- **FSRS-6 default weights.** Newer; switching is one array once the weights are
  re-optimised on our own reviews.

## Correspondence of old references

§1–§9, §11, §12, §14 and §15 keep their numbers (§12, §14 and §15 were retitled and condensed on 2026-11-08; their old anchors still land on them). Code and documents also cite:

<a id="10-second-round-product-owner-2026-09-29"></a><a id="13-third-round-product-owner-2026-09-29-review-of-slice-2"></a><a id="left-open"></a>

| Old reference | Now |
| --- | --- |
| §10 (second round), introduction: every first-version proposal accepted, item 3 changed | the items below, marked *(Second round)* |
| §10 item 1 (a card enters as new), item 2 (a poll creates no card) | [§1](#1-when-a-question-becomes-a-card) |
| §10 item 3 (turning off keeps the cards; "Remove these questions from the drill"; editable until release; templates) | [§2](#2-allow-drill-per-evaluation) |
| §10 item 4 (opt-out per classroom) | [§6](#6-opt-in-and-the-session) |
| §10 item 5 (automatic and final, no `llm` matcher), item 6 (`toDrillGrade` removed) | [§3](#3-the-types-of-v1) |
| §10 item 7 (no reference time: Good, fixed fallback) | [§4](#4-the-rating-strategy-a-correctness-and-time) |
| §10 item 8 (recall rate), item 10 (mastery) | [§8](#8-data) |
| §10 item 9 (10 new cards a day, a long card served alone) | [§6](#6-opt-in-and-the-session) |
| §10 answer-key hash | [§7](#7-question-edits) |
| §10 retention anchors | [§8](#8-data) |
| question 28 (a), (l) | [§8](#8-data) |
| question 28 (b), (c), (f), (g), (k) | [§6](#6-opt-in-and-the-session) |
| question 28 (d), (e), (i) | [§4](#4-the-rating-strategy-a-correctness-and-time) |
| question 28 (h) | [§2](#2-allow-drill-per-evaluation) |
| question 28 (j) | [§1](#1-when-a-question-becomes-a-card) |
| §10 and §13, UI copy obligations of slice 3 | [§14](#14-the-students-screens-and-the-teachers-switches) |
| §12 "Implementation choices of slice 2" | [§12](#12-the-drill-day-the-review-in-progress-and-the-hooks); full text in the [historical record](history/ADR-041-entrainement-espace.md#12-implementation-choices-of-slice-2) |
| §14 "Implementation choices of slice 3 (the screens)": the list walked on the client, the calendar-day wording, where the switch sat first | [§14](#14-the-students-screens-and-the-teachers-switches); full text in the [historical record](history/ADR-041-entrainement-espace.md#14-implementation-choices-of-slice-3-the-screens) |
| §15 "Implementation choices of slice 4 (the teacher's view)": the routes, the SQL window function, the sheet's two charts | [§15](#15-the-teachers-view); full text in the [historical record](history/ADR-041-entrainement-espace.md#15-implementation-choices-of-slice-4-the-teachers-view) |
| §13 item 1 (backfill), item 2 (an exercise's key; ADR-050's amendment, "§13.2"), item 3 (withdrawn release) | [§1](#1-when-a-question-becomes-a-card) |
| §13 item 4 (the version served) | [§7](#7-question-edits) |
| §13 item 5 (the opt-out is visible) | [§6](#6-opt-in-and-the-session) |
| §13 item 6 (unanswered questions become cards) | [§3](#3-the-types-of-v1) |
| Left open | [Consequences](#consequences) |
| Rollback (removed 2026-10-09) | [Consequences](#consequences) |
