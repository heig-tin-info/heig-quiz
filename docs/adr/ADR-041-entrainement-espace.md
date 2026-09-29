# ADR-041 — The drill: spaced practice, scheduled by FSRS, rated by correctness and time

## Status

Accepted (2026-09-29, decided by the product owner in issue #317, last
comment; with slice 1 of that issue: `drillSchedule`, `drillRating`,
`drillSession` and `drillProgress` in `@quiz/domain`, and the `ts-fsrs`
dependency of that package). Amends F-DRILL-01 to F-DRILL-04 and adds
F-DRILL-06 (docs/spec/02),
N-DATA-02 and N-DATA-03 (docs/spec/03), the `toDrillGrade` row of the
question-type contract (docs/spec/04 §4.1) and the drill tables of
docs/spec/05 §5.4. Slices 2 to 4 (the `drill` module, the student's tab,
the teacher's view) implement the rest and will add their files here.

## Context

The spec reserved a phase-2 drill in five lines (F-DRILL-01..05): every
question a student meets becomes a card, FSRS schedules it, the student has
a drill tab, the teacher sees aggregates only. Issue #317 turned it into a
product: a daily practice of about ten minutes, on a phone or a computer,
over the questions of the evaluations of the student's current classrooms,
where a question often failed comes back sooner and an old one comes back
now and then to check it is still remembered.

Five facts shape the design:

- an exam question drilled before its results are released would reveal
  its correctness early: a leak of the grade;
- a teacher who reuses exam questions year after year may not want them
  practised forever;
- the same question takes longer on a phone, and time is part of mastery
  (a right answer found after a long search is not a known one);
- the scheduler needs a history to be re-tuned later, which is personal
  data held for years;
- `@quiz/domain` is pure (invariant 8) and imported by the web app too.

## Decision

### 1. When a question becomes a card

A card is `(student, question)`, one per pair, created **at the release of
an exam's results**, never before, and **at the hand-in of an exercise**
(its submission; a later attempt of the same exercise creates nothing new).
A poll creates no card. A card is created only for a question of a drill
type (§3), for an evaluation that allows drill (§2), in a classroom where
drill is enabled (§6).

The answer given in the evaluation is NOT the card's first review: its time
was taken under other conditions (an exam's pace, no feedback). The card
enters as **new**, and the day's cap on new cards (§6) spreads a large exam
over several days.

### 2. "Allow drill", per evaluation

`settings.allowDrill`, a boolean of the evaluation's settings: **on by
default for an exercise, off by default for an exam**, where the teacher
chooses it at creation (and in the settings, like any other setting until
the release). It is copied into a template and from it (F-EVAL-18) like the
other settings. It only gates the creation of cards: turning it off later
leaves the cards already created (the student has met the question).

### 3. The types of v1

`mcq`, `short`, `cloze` and `categorize` — `DRILL_TYPES`. They are graded
at once, without a runner. `rich` (graded by hand) and `circuit` (an
ngspice run per review is too slow for a drill) are out. `code` and
`codeimage` come later, through the browser runner (ADR-015), on a computer
only. A `short` question whose matcher is `llm` is not graded at once and
takes no card either.

### 4. The rating: strategy A, correctness and time

The FSRS rating (1 Again, 2 Hard, 3 Good, 4 Easy) is computed, never asked
(`drillRating`):

| Correctness | Time `t` against the reference `ref` | Rating |
|---|---|---|
| wrong or empty | any | 1 Again |
| partial | any | 2 Hard |
| right | `t > 1.5 × ref` | 2 Hard |
| right | `0.6 × ref < t ≤ 1.5 × ref` | 3 Good |
| right | `t ≤ 0.6 × ref` | 4 Easy |
| right | no reference yet | 3 Good |

The factors are `DRILL_SLOW_FACTOR` and `DRILL_FAST_FACTOR`, named
constants to retune from `drill_reviews`.

**Correctness** comes from the type's ordinary `grade`, the one of the
evaluation, through its points (`drillCorrectness`): every point is right,
none (or a negative score under negative marking, ADR-026) is wrong, the
rest is partial. So the contract's `toDrillGrade(grading)` hook is not
needed and is dropped from docs/spec/04 §4.1: strategy A needs correctness,
not a rating, and correctness is the same function of the points for the
four v1 types — `mcq` (with its policy), `short` (its matcher), `cloze`
(per blank) and `categorize` (its policy). A later type whose points do not
say "right" (a code question with a partial test suite, say) may add a
hook then.

**The time** is the question's ACTIVE time: the clock pauses while the tab
is hidden. It is measured by the server, as the dwell of ADR-039 is (the
client reports what is on screen and when it hides; the server's clock
sums the intervals), never taken from the browser (invariant 5).

**The reference time** (`drillReferenceMs`): the **median** of the correct
times on this question, by every student, **on the same device class**,
once there are `DRILL_REFERENCE_MIN_N` = 10 of them; before that, the
student's own previous correct time on it (same class); failing that, an
estimate per question type; failing that, none, and time is not judged.

**The device class** is recorded on each review: `coarse` (a touch screen,
the test of `useCoarsePointer`) or `fine`. Times are compared only within
one class.

Strategy C (the rating proposed, adjustable by one step by the student) can
come later; strategy B (self-rating alone) is not taken.

### 5. The scheduler: FSRS-5, target retention 0.9

`drillSchedule` wraps the **`ts-fsrs`** library (MIT, no dependency, ESM,
Open Spaced Repetition) behind four functions: `newDrillCard`,
`reviewDrillCard(card, rating, now)`, `drillRetrievability(card, now)`,
`isNewDrillCard`. The card is exactly the columns of `drill_cards`
(stability, difficulty, due date, last review, reps, lapses); no type of the
library leaves the file.

- **FSRS-5 with its default weights**, and a **target retention of 0.9**
  (`DRILL_TARGET_RETENTION`). `ts-fsrs` 5 implements FSRS-6; the 21 weights
  passed are FSRS-5's 19 followed by `0, 0.5`, which is exactly FSRS-5
  (no same-day stability term, decay 0.5). Re-optimised weights (slice 4)
  replace that one array.
- **The long-term scheduler only**: no learning steps (a drill reviews a
  card at most once a day, so minute-scale steps have no session to land
  in), and **no fuzz**: the same review gives the same due date, which
  keeps the function deterministic and testable.
- The scheduler is built on first use, not at import, so the web bundle,
  which imports `@quiz/domain`, does not carry the library.

A port of FSRS-5 into the package was the alternative: some hundred lines,
but our own to maintain and to keep in step with the reference
implementation that the re-optimisation of slice 4 will use.

### 6. Opt-in, and composing a session

The **teacher enables** the drill for a classroom. Its students are then
**in by default and may opt out**, for that classroom. A classroom without
the drill creates no card and shows nothing.

A session is composed by `composeDrillSession` from the student's cards at
the server's `now`:

1. the **due** cards first, the lowest retrievability ahead (the nearest to
   being forgotten), then the oldest due;
2. then the **new** cards, oldest first, at most what today still allows
   (`DRILL_NEW_PER_DAY` = 10 minus those introduced today);
3. taken in that order while the sum of their reference times fits the
   **time budget** (`DRILL_SESSION_BUDGET_MS`, 10 minutes, until F-ADMIN-03
   sets another); the first card that overruns it ends the session, which
   may end early. A session is never empty while a card is available: a
   card longer than the whole budget is still served alone;
4. the due block, then the new block, each **interleaved** by group — a
   course or a tag, the caller's key — round-robin, rather than in blocks.

Nothing due and nothing new: an empty session.

**No reminders and no streaks in v1.** Only a "today's drill is available"
badge, on the home and on the centre slot of the student's bottom bar.

### 7. Question edits

A card is on the QUESTION, not a version, and a review uses its latest
published version. An edit keeps the card's FSRS state, **unless the answer
key changed**: then the card is reset to new. The card stores a hash of the
key it was last reviewed on (`toSolution` under a fixed view); a different
hash at the next review resets it.

### 8. Data: five years, and the teacher sees each student

This deliberately **amends F-DRILL-04**, which said "never the individual
detail by default":

- **Retention: five years** for a student's drill data (cards and reviews):
  three years of studies, four part-time, one repeated. A review is deleted
  five years after it was made; a card five years after its last review, or
  its creation if it was never reviewed.
- **The teacher sees each student's individual activity** in a classroom
  with the drill: whether they practise — questions seen, reviews, sessions —
  and a measure of improvement over time (`drillProgress`, below), for
  instance to see the progression at the end of the semester. Mastery per
  tag is also shown per classroom.
- **The student is told**, in the drill tab, that their teacher sees this
  activity; the data-protection page (N-DATA-07, #274) says so too.

**The improvement metric** is the **recall rate**, per time window (a week,
say): among the reviews of a question the student had ALREADY drilled
before, the share not rated Again. The first drill review of a question is
left out: it measures what the evaluation left, not what the practice kept.
It is FSRS's "true retention", so a student whose schedule works sits near
the target (0.9); its rise across windows is the progression. With it,
per window: reviews, distinct questions, and sessions started (a pause of
more than 30 minutes, `DRILL_SESSION_GAP_MS`, starts a new one). A window
with no repeated review has no rate (`null`), not a zero.

## Consequences

- The domain rules exist before any table: slice 2 wires them to the
  `drill` module without deciding anything of this ADR again.
- `@quiz/domain` gains its first third-party dependency, `ts-fsrs`, used by
  the server only.
- A card's first review is often rated on the student's own time or a type
  estimate: the median needs ten correct answers on the same device class.
  Early ratings are therefore coarse, and improve on their own.
- Five years of reviews per student: tens of thousands of short rows for a
  diligent student over a programme, well within one PostgreSQL.
- The teacher's view is individual: the drill tab's notice and the
  data-protection page are part of the feature, not an afterthought.

### Rollback

Everything of slice 1 is additive: four files of `@quiz/domain`, unused
until slice 2. Removing them and the dependency restores the package.

## Alternatives considered

- **Self-rating (strategy B).** One more tap per card, and easily gamed.
- **A fixed number of questions per session.** Ten `mcq` and ten `cloze`
  are not the same effort; a budget in time is what the student sees.
- **The evaluation's answer as the first review.** Its time is an exam's,
  and an exam's correctness would be shown before the release.
- **Aggregates only for the teacher (F-DRILL-04 as written).** The product
  owner wants to see who practises and who progresses; the student is told.
- **FSRS-6 default weights.** Newer, but FSRS-5 is what #317 proposed and
  its weights are widely reported; the switch is one array once slice 4
  optimises on our own reviews.
- **A per-type `toDrillGrade` hook.** Four identical implementations of
  "points out of the maximum".

## Left open

Recorded in docs/spec/06, question 28: whether the deletion of a classroom
or a question deletes the drill data it gave rise to (assumed: no, the
five-year clock governs); the "extra practice" on the weakest tags when
nothing is due; a shorter budget, or types left out, on a phone; damping
Easy on questions without variants; the settings that grade a review when
a question was met in evaluations with different policies (negative
marking, categorize policy); opening a whole pool to drill (F-DRILL-01,
second sentence); and what "the current year" is when a card's classroom is
archived. Each has an assumed answer there, to be confirmed before slice 2
relies on it.
