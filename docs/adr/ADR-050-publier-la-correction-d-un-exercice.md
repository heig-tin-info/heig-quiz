# ADR-050 — Publishing the correction of an exercise that is still running

## Status

Accepted (2026-09-30, settled with the product owner; with the column
`evaluations.correction_published_at` (migration
`0039_correction_published.sql`), the route `POST
/evaluations/:id/publish-correction`, the audit action
`evaluation.correction_publish`, and `@quiz/domain/correction`
(`isDebriefOpen`, `correctionPublishRefusal`, `feedbackGate`)). Amends
ADR-033 §1 and ADR-025 §4, and overrides the spirit of
`docs/spec/06-questions-ouvertes.md` row 5 for exercises, by an explicit
act of the teacher. Amends ADR-041 §13.2 (the drill follows). Settles
open question 34 (the drill). Amended 2026-10-02 by ADR-067 (§3): every
exercise is graded at hand-in, published or not; a reopened attempt's
automatic gradings are stood down.

Amended 2026-10-09: the Rollback section is removed (the runbook owns operational procedures).

## Context

An `exercise` is practice: its grade carries little meaning. The product
owner wants to project the correction of an exercise in class WITHOUT
closing it, so that the students keep working and retake afterwards. Two
rules forbade it:

- ADR-033 §1: `GET /evaluations/:id/results/by-question` — the Results
  "Questions" tab and its projection — answers `409 not_over` until the
  evaluation is `closed`, `grading` or `released`: "a key on the wall while a
  student still answers, is late, or can retake an exercise is what the
  projection must never do";
- ADR-025 §4: while an exercise with retakes is open, the feedback of a
  finished attempt is `available: false, reason: "retakes_open"` with the
  score only, whatever the feedback policy says — the correction of attempt
  1 would be the key of attempt 2.

Both rules are right as defaults. What they cannot express is a teacher who
decides, on purpose, that the key of this exercise may now be read.

## Decision

1. **A timestamp, set once by the server.** `evaluations.correction_published_at`
   (nullable, like `released_at`) records the instant the correction was
   published, read from the server's clock. It is not a setting: settings
   are frozen while an evaluation runs (`configLock`) and every setting is
   patchable, that is reversible. It is not a state either: the ticker, the
   retakes (`retakeRefusal`) and the score-only masking all key on
   `running`/`paused`, and must keep doing so. The column is cleared only by
   a return to `draft` — `closed → draft`, allowed while nobody has an
   attempt — where nobody's paper met it.

2. **One route, irreversible and idempotent.** `POST
   /evaluations/:id/publish-correction` with `{ confirm: true }`
   (`PublishCorrectionBody`), staff only (`staffAccess`, 404 otherwise). It
   is refused on an `exam` or a `poll` — `422 correction_not_allowed` with
   `reason` — and on an exercise that is not `running` or `paused`
   (`CONFIG_LIVE_STATES`) — `409 correction_not_open`: in the waiting room
   nobody has handed anything in, and after the close the ordinary debrief and
   the release take over. A second call answers `200` with the FIRST instant and
   does nothing else — no second audit row, no grading: a double click or a
   colleague on the same dashboard is not an error, as a re-release keeps the
   original `released_at`. The write is one conditional `UPDATE` (still
   unpublished, still running — the mode was checked before and is frozen),
   so a close committing in between is seen. There is no route to unpublish. The action is audited as
   `evaluation.correction_publish` with the number of attempts sent to
   grading.

3. **Grading.** Publishing sends every finished (`submitted`, `expired`)
   attempt that nothing has graded yet to the grading pass, and from then on
   every attempt handed in on that exercise is graded alone at hand-in, as a
   retake already was (`gradeAtHandIn`: "retakes enabled OR correction
   published"). Hand- and LLM-graded answers stay proposals and count
   nowhere (ADR-033 §2, unchanged).

   **No attempt is reopened any more** (`409 correction_published`, beside
   ADR-025's `retakes_enabled`; one rule, `reopenRefusal`, which the live
   grid reads as `DashboardView.evaluation.reopenable`, so it never offers a
   refused Reopen). A reopened attempt keeps its gradings, which are
   validated, and the grading pass never re-grades a validated cell: what
   the student rewrote — with the correction in hand — would never be
   graded. A student who needs another go on an exercise with retakes starts
   one; without retakes, the teacher chose to publish before the end.

   *Amended by ADR-067 (2026-10-02): every exercise grades its attempts at
   hand-in, so "from then on" no longer depends on the publication. A reopen
   of an exercise that is not published now stands the attempt's automatic
   gradings down, so what a reopened student rewrites is graded; the refusal
   once the correction is published stays, for its other reason: the student
   would rewrite with the correction in hand.*

4. **The projection.** `not_over` is lifted once the correction is
   published (`isDebriefOpen`). While the exercise is still open the debrief
   counts FINISHED attempts only: the kept attempt of ADR-025 §3 falls back
   to the latest when a student has none finished, and a paper still being
   written is nobody's result, so such an attempt is left out. The payload
   carries `papers`, the number of papers counted (on each item, since the
   response is an array), and the projection's header reads "Handed in so
   far: n" while the exercise is open. A question's own "out of n papers"
   counts less when some answers are still proposals: those papers are
   handed in but in no outcome (ADR-033 §2), which is why the header is
   worded apart. It is read on load; there is no live refresh.

5. **The student's own page.** Publishing counts as the release for the
   feedback policy (`feedbackGate`): under `on_release` the student sees
   their correction as if released, under `immediate` likewise; `none` stays
   nothing. The `retakes_open` masking is lifted once published, except under
   `none`, where the score stays (enabling retakes is still the teacher's
   consent to it). The key appears only under `showKey`, the explanation only
   under `showExplanation`: the other options apply unchanged, through the
   same `studentFeedback` path (`studentView`, `studentSolutionView`, the
   details filter) as a released evaluation — invariant 4 holds by
   construction. The feedback policy stays patchable while the exercise
   runs: a teacher who switches to `none` after publishing wins, and the
   student no longer sees the correction; only the publication itself — the
   projection — is irreversible. Retakes continue normally (`retakeRefusal`
   unchanged), and the page that shows the correction still offers **Try
   again** (`StudentFeedback.retake`).

6. **The drill follows by construction.** ADR-041 §13 serves an exercise's
   card once `results.keyShownTo` says the key reaches that student, and
   `keyShownTo` reads the same `feedbackAvailable` as the feedback page. A
   published correction therefore opens the drill's cards of that exercise,
   under `showKey`, to each student whose latest attempt is finished — and
   holds them back again while a retake is being written. No drill rule was
   added.

7. **Teacher screen.** "Publish the correction" is a tertiary action of the
   live dashboard's header, in its overflow menu, offered on a running
   exercise — where `correctionPublishRefusal` accepts it — and nowhere
   else; the screen's primary stays
   what it was. A confirmation says what happens under THIS evaluation's
   feedback policy: the exercise stays open and students keep working (and
   retaking, when retakes are on); the projection becomes available on the
   papers handed in so far; what students will see on their results page
   (the correction with or without the key, or nothing under `none`); and
   that it cannot be undone. Once published, a badge beside the state says
   so and the same menu offers "Present the correction"; the Results page's
   "Present" is enabled by the same rule (`hasCorrection`).

## Consequences

- A student on attempt n can open attempt n−1's correction in another tab
  and keep answering. Accepted: this is practice, and the teacher chose to
  publish. A `best` grade is inflated by it; nobody should read an
  exercise's grade after a publication as a measure of anything.
- A withdrawn release (`unrelease`) no longer hides the correction of an
  exercise whose correction was published: the publication stands.
- A hand-in racing the publication — its request loaded the evaluation
  before the publication committed, and the publication listed the finished
  attempts before the hand-in committed — is not graded until the close
  pass. The window is a few milliseconds; the close grades everything.
- A reopen racing the publication in the same way — loaded before it
  committed, its attempt update landing after the publication listed the
  papers to grade — reopens a paper the queued grading then grades. The
  answers rewritten after that are not graded again, since the pass skips a
  validated cell, and the close does not repair it. The window is a few
  milliseconds; the teacher's override (F-GRADE-05) corrects such a paper.
- The publication is committed before the grading is enqueued, outside one
  transaction: a crash between the two leaves the papers handed in before
  it ungraded — their students read "not graded" — until the close, whose
  pass grades every attempt. Accepted: rare, visible, and repaired by the
  ordinary path.
- A teacher can no longer rescue one student's attempt by reopening it
  after publishing (a laptop that died mid-attempt stays closed); on an
  exercise with retakes the student starts another attempt.
- The students' results pages are told to re-read (`results` hint) at the
  publication, so an open page shows the correction without a reload.
- An exam is untouched: its correction waits for the close and the
  release, always.

## Alternatives considered

1. **A setting** (`settings.correctionPublished`): settings are frozen while
   the evaluation runs (`configLock`) and patchable back and forth when they
   are not; the publication must be possible mid-run and must not be
   undone.
2. **A new state** (`running_published`): the ticker, `retakeRefusal`,
   the score-only masking and every screen that switches on the state would
   each have to learn it, for a flag that changes none of their rules.
3. **Projection only** (the debrief opens, the students' pages stay as
   they are): the product owner wants the students to read their own
   correction too — a projected key the students cannot find again on their
   page is half the correction.
4. **Freezing the kept attempt at publication** (the grade stays the one
   of the attempts handed in before): out of scope; the grade of an
   exercise carries little meaning, and freezing it would add a second
   snapshot beside ADR-012's for no reader.
