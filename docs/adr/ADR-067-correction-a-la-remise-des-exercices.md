# ADR-067 — Grading an exercise at hand-in

## Status

Accepted (2026-10-02, settled by the product owner after an incident in
production). Implemented by `gradeAtHandIn` and `reopenAttempt`
(`apps/api/src/modules/live/attempt.ts`), `standDownAutomaticGradings`
(`apps/api/src/modules/grading/service.ts`), the pass and the runner job of
`apps/api/src/modules/grading/jobs.ts`, and `GRADING_RUNNER_CONCURRENCY`
(`apps/api/src/config.ts`), the rule `gradableNow` (`@quiz/domain`,
`retake.ts`); the student's page by the sibling pull request
`feedback-pending` (`results/service.ts`, `feedbackGate`), merged right
after this one. Amends ADR-025 §4
and ADR-050 §3, and F-GRADE-01 of `docs/spec/02-exigences-fonctionnelles.md`.
Settles open question 50 of `docs/spec/06-questions-ouvertes.md`.

Amended 2026-10-09: the Rollback section is removed (the runbook owns operational procedures).

## Context

The exercise "Premiers pas en C" — mode `exercise`, feedback `immediate`,
no retakes, open for a week — showed every student who handed in "1.0,
0/24", every question "Not graded". The grading pass graded a finished
attempt alone only on an exercise with retakes (ADR-025 §4) or whose
correction was published (ADR-050 §3); everywhere else the pass of the
evaluation's close graded every attempt. An exercise open for a week left
its students in front of an empty grid for a week, and the page computed a
grade, 1.0, from no gradings at all.

F-EVAL-11 says `immediate` shows the feedback "after the student validates
a question". The platform never graded per question: the pass works on
finished attempts, and a question validated in `forward_only` is still
part of an attempt the student has not handed in.

## Decision

1. **An exercise is graded at hand-in.** Every attempt of an `exercise`
   that ends while the exercise runs (`running`, `paused`) — handed in by
   the student, expired by the ticker, closed by the teacher — is sent alone
   to the usual pass (`grading.evaluation` with `attemptIds`), whatever the
   feedback policy, retakes or not, correction published or not. The
   condition of `gradeAtHandIn` is the mode, no longer "retakes enabled OR
   correction published". Deterministic types are validated at once; a
   `code`, `codeimage` or `circuit` answer goes to the runner queue; an essay
   and a diagram stay pending until the close, since no model is asked while
   an evaluation runs (F-LLM-03, unchanged). The close's pass still grades
   whatever is left.

2. **An exam is graded at its close**, as before: nothing is graded while
   it runs. A poll has no key, and its pass writes nothing.

3. **`immediate` is applied per hand-in, not per question.** F-EVAL-11's
   "after the student validates a question" is read as "once the attempt is
   handed in": that is when it is graded, and grading a single question
   while the attempt is still open would show the key of a question whose
   neighbours are still being written.

4. **A reopen stands the automatic gradings down.** A plain exercise may
   still be reopened (`reopenRefusal` is unchanged: refused with retakes,
   ADR-025, and once the correction is published, ADR-050). The grades its
   hand-in produced no longer describe what the student will hand in next,
   and the pass never re-grades a validated cell, so `reopenAttempt`
   supersedes, in the same transaction as the reopen, every standing
   grading of that attempt the machine alone wrote: `source = 'auto'` (the
   runner's included) with no `graded_by`. They are superseded with no
   successor, as a re-grade stands a cell down (`regradeItem`): nothing is
   deleted and the history of the cell keeps them (F-GRADE-05). What a
   teacher settled stays: an override (`manual`), a proposal they validated
   (which keeps its source but carries their `graded_by`). The next hand-in
   grades the stood-down cells again. Extra time (`extendTime`) never
   revives a finished attempt, so the reopen is the only path concerned.

   **A reopen and a grading write are serialised on the attempt's row.**
   A pass loads its attempts, grades, then writes; a reopen may land in
   between, and a check made at load time cannot see it: the pass would
   write the old answers' grades, validated, on an attempt the student is
   rewriting, and no later pass re-grades a validated cell. So:

   - `reopenAttempt` takes the attempt's row lock (`SELECT … FOR UPDATE`)
     in the transaction that reopens it and stands its gradings down;
   - every grading write of the jobs (the pass's batch, the runner job's
     single write) runs a guard first inside its own transaction
     (`writeGradings(db, inputs, guard)`): it locks the attempts of its
     cells, in id order, re-reads their state and their evaluation's under
     the lock, and drops the cells of an attempt that is no longer gradable
     — `gradableNow`: while the evaluation runs, only a finished attempt;
     the pass's guard also drops an attempt whose `closedAt` differs from
     the one it loaded: a reopen clears it and the next hand-in writes a new
     one, so an attempt reopened AND handed in again between the pass's load
     and its write — finished again, on other answers — is left to its own
     hand-in's pass;
   - the runner job's guard also re-reads, under the same lock, the
     revision of the answer, which every runner job now carries: an answer
     is written only while its attempt is open, and opening it takes the
     lock, so a job built from another revision writes nothing — the hand-in
     after the reopen sent a job of its own. A job queued before this
     decision was deployed carries no revision and is taken as current:
     nothing would send it again once its evaluation is closed;
   - an answer save takes the attempt's row in share mode and re-runs the
     write gate under it: a hand-in ends the attempt under the update lock
     and its pass reads the answers right after, so a save racing the
     hand-in either commits before it or is refused (`410 attempt_closed`),
     never lands after the pass has read.

   Either the write commits first, and the reopen's stand-down supersedes
   what it wrote, or the reopen commits first, and the write drops those
   cells. The checks made before (the pass's load, the runner job's check
   before the run) remain as cheap early exits — a stale job takes no runner
   slot — but the one under the lock decides.

5. **The runner is shared with the students.** The runner serves the
   grading and the students' Run clicks from one FIFO of its own
   (`RUNNER_CONCURRENCY`, `apps/runner/src/queue.ts`). An exercise graded
   at every hand-in sends grading runs while the class is still running
   code, so the API takes `grading.runner` jobs `GRADING_RUNNER_CONCURRENCY`
   at a time, one by default: a background grading holds at most one slot,
   and the rest stays the students'.

6. **What the student reads** (landing with the sibling pull request
   `feedback-pending`, merged right after this one; recorded here because it
   is the other half of the incident):

   - the feedback page never computes a grade while cells are pending: it
     shows the points and "n questions awaiting grading";
   - an exercise shows the points only, never a grade, before the release;
   - an exam shows nothing before the evaluation is closed, whatever its
     feedback policy says; the rule is `feedbackGate`'s, which also holds
     back the drill cards (`keyShownTo`) of a legacy exam whose policy was
     set to `immediate` before that value was refused for exams.

## Consequences

- An exercise's students read their points at hand-in, on every exercise,
  instead of a grid of "not graded" until the close.
- The close's pass of an exercise does little: most attempts are graded
  already, and the pass skips a validated cell.
- On an exercise of many code questions, the runner jobs of the hand-ins
  queue behind each other, one at a time: a student's code score may take
  a while to arrive, while the Run button stays responsive. A larger runner
  raises `GRADING_RUNNER_CONCURRENCY`.
- A reopened attempt's automatic grades disappear from the teacher's grid
  until the student hands in again; the cell history shows them superseded.
- `pointsAcrossRegrade` reads a superseded row with no successor as stood
  down by a re-grade; a reopen leaves the same shape, on an evaluation that
  is running, which `results_updated` (released evaluations only) never
  watches.

## Alternatives considered

- **Grade at hand-in only under `immediate`.** Rejected: an `on_release`
  exercise left open for a week shows the same empty grid to the teacher's
  panel and the live statistics, and the student's points are not the key.
- **Grade each question when it is validated.** Rejected: see §3; and a
  question is not validated in every navigation mode.
- **Refuse to reopen an exercise graded at hand-in**, as ADR-050 does once
  the correction is published. Rejected: a reopen is how a teacher rescues a
  student whose laptop died; standing the automatic grades down costs one
  UPDATE.
- **Delete the gradings on reopen.** Rejected: F-GRADE-05 keeps every
  grading; the supersede mechanism already exists.
