# ADR-038 — Question statistics in the pool: success rate, and a reset

## Status

Accepted (2026-09-29, decided by the teacher who owns the product; with the
`stats` module of `apps/api`, `itemStats` / `shownItemStats` in
`@quiz/domain/stats`, the contracts of `@quiz/contracts/stats` and the
column `questions.stats_since`, migration `0032_question_stats_since`).
Revises F-STAT-01 to F-STAT-03 and adds F-STAT-05 (docs/spec/02). The time
spent on a question comes in a second step, announced in §8.

Amended by ADR-039: the time spent (§8) and the "not reached" rule (§2).
Extended by ADR-040: the discrimination index, over the same counted answers.

## Context

The specification promised item statistics per question VERSION in the
pool (F-STAT-01, spec 05 §5.2 `stats`, spec 08 §8.5), from phase 2. A
teacher choosing a question for next week's test asks one thing: "how did
students do on it?". The history to answer it is already in the database —
every validated grading of every item, and the version each item froze —
and nothing showed it outside the results of one evaluation.

Four facts constrain the answer:

- A question gets a new version for a typo as often as for a real change;
  per version, a pool's numbers would split into slices too thin to read.
- Grades are personal data (N-DATA-06): an aggregate over a handful of
  students is a grade in disguise.
- Negative marking (ADR-026) makes a question's mean fraction negative when
  it takes away more than it gives.
- An exercise with retakes (F-EVAL-15, ADR-025) holds several attempts per
  student, of which one is the student's result.

## Decision

### 1. One number per question, every version pooled

The unit is the QUESTION: its items in every evaluation, whatever version
they froze, are one series. This overrides "per version" in F-STAT-01, spec
05, spec 08 and spec 00. A teacher who rewrote a question enough to want a
fresh start resets it (§6).

### 2. What is counted

One answer is counted when all of these hold:

- its grading is `validated` (a proposal alone is not a grade; a superseded
  grading is replaced by the validated one, so a cell counts once);
- its item froze a version of the question;
- the evaluation is an `exam` or an `exercise` — never a `poll`;
- the attempt belongs to a student account (no guest), is `submitted` or
  `expired`, and has a `started_at`;
- the attempt is not a teacher's test walk from a staff seat (ADR-018);
- on an exercise where the student holds several attempts, it is the KEPT
  one (`best` or `last`, ADR-025) — and when the kept attempt's grading of
  this item is not validated yet, the student is not counted at all, never
  replaced by another of their attempts;
- the item is worth something (`max_points > 0`);
- the attempt started at or after the question's `stats_since` (§6).

A blank, skipped or unanswered question counts 0: its grading is a
validated 0 (F-GRADE-01). A student with no attempt at all is NOT counted,
unlike the results page, which gives an absent student a row: the
statistics are about the question, and a student who never opened the
evaluation says nothing about it.

Two cases cannot be told apart today: a question the student saw and left
untouched, and one they never reached (a timed exam that ended first, a
`forward_only` walk). `answers.first_seen_at` is written on the first save
or flag, not on display, and there is no view event. Both count 0, which
biases the last items of a long timed exam downwards. The remedy is the
server-measured dwell of §8.

*Amendment (ADR-039): on an attempt that reports what is on screen
(`display_tracked`), a question never displayed is left out of `p`; a
blank the student saw still counts 0, and older attempts keep the rule
above.*

### 3. The success rate, signed, with its n

`p` is the mean of `points / max_points` over the counted answers, rounded
to two decimals, reported with `n`, the number of answers. It is SIGNED:
under negative marking it may be below zero, and the panel says so in one
sentence. The results screens clamp a rate at 0 for a class
(`displayedRate`); the author of a question is the one reader who needs to
see that it takes points away. No standard deviation, no minimum, no
maximum: they bring an individual grade back from an aggregate (N-DATA-06).

### 4. A threshold, enforced by the server

Below `QUESTION_STATS_MIN_N` answers (ten), a question has no statistics:
it is absent from the pool list, the one route that serves them. The
threshold is applied in the `stats` module, so a smaller `n` never travels
to a browser, not even hidden.

### 5. Who sees them

Anyone who can READ the pool (ADR-013): owner, contributor, reader, course
staff of a linked course, every teacher for a public pool. They read an
aggregate over the classes of other teachers too — acceptable, because it is
an aggregate of ten answers or more, about a question they may use. A
question moved to another pool (ADR-017) keeps its id, so its history
follows it; a copy starts empty.

### 6. The reset

A contributor or an owner may reset a question's statistics (F-STAT-05):
`questions.stats_since` takes the server's now, and only attempts STARTED at
or after it count from then on. Nothing is deleted — answers, gradings,
grades and results stay as they are — and the reset is audited
(`question.stats_reset`, with the pool and the previous instant). The web
app asks for a confirmation first.

The attempt's START is the only instant that works: a grading's `graded_at`
moves on a regrade, an override or a late validation, so an old answer
would come back after a reset; `submitted_at` is null on an expired attempt.
This replaces F-STAT-01's "per year": a teacher who wants a year's numbers
resets at the start of the year.

### 7. Where the code lives

- The READS are a new `stats` module (`apps/api/src/modules/stats/`),
  depending on `grading` (the kept attempts), `evaluation` (the staff
  predicate) and the guards. Not in `pool`: `grading` already reaches
  `pool` through `evaluation`, and `pool` depending on `grading` would close
  the cycle.
- The RESET is a write to `questions`, which belongs to `pool`: it is
  `POST /questions/:id/stats/reset` in `pool/questionRoutes.ts`.
- `GET /pools/:id/question-stats` answers the whole pool in one call, each
  entry with its `since`; the pool screen merges it with its rows by id and
  the side panel reads its entry, with no request of its own. After a reset
  the panel closes and the question leaves the list. `QuestionRow` and
  `listQuestions` do not change, so the MCP tool `list_questions` does not
  carry statistics; an MCP tool for them is a follow-up.
- `isStaffAttempt` (`evaluation`) is THE staff-attempt predicate, which
  `staffAttemptIds` now reads too; `keptAttemptsOf` (`grading`) is the kept
  rule over several evaluations, which `keptAttempts` calls for one.

### 8. Next: the time spent

A second step adds the time students spend on a question: median, P25 /
P75 and mean — the mean because F-STAT-04 adds durations up, and means add
up where medians do not. Exams only (an exercise is done over days), and
measured by the SERVER from a dwell the player reports, which does not
exist today.

*Done by ADR-039: the dwell, its idle cap and the time shown in the panel.*

## Consequences

- The pool's table and cards show a chart icon after the name of every
  question with statistics; it opens a side panel, for a reader too.
- One query gathers the candidates, one loads their evaluations, two find
  the kept attempts (the points only of students who hold several). Every
  counted answer travels to the process. Should a pool's history outgrow
  that, the same filters pre-aggregate in SQL, and only the attempts of
  students who retook an exercise are fetched one by one.
- The filters on statistics that F-STAT-03 promises are still to do.

### Residual risk

A reader who reads a question's figures just before and just after ONE new
answer is counted (`n` from 10 to 11) can infer that answer's points by
differencing `p`. Accepted: the figures carry no identity, and a teacher who
could narrow the answer down to one student already sees that class's
results. Should it ever matter, two mitigations exist, neither built: a
coarser rounding of `p`, or refreshing the figures only when an
evaluation's results are released.

### Rollback

Dropping the routes and the panel hides everything; the column is inert
without them. Nothing else reads `stats_since`, and nothing was deleted.

## Alternatives considered

- **Per version, as the specification said.** Thin slices, and a typo fix
  would reset the numbers without anyone asking.
- **The grading time as the reset's reference.** A regrade would bring a
  pre-reset answer back into the numbers.
- **Statistics in `QuestionRow`.** Every list of questions — the evaluation
  picker, the MCP tool — would pay for a join most never show, and the
  threshold would have to be applied at each of them.
- **A reset that deletes.** The gradings are the students' grades; a
  statistics button must not be able to touch them.
- **Aggregation in SQL.** The kept-attempt rule lives in `@quiz/domain` and
  reads whole-attempt totals; rewriting it in SQL would be a second
  definition of it. Kept as the fallback of the Consequences.
