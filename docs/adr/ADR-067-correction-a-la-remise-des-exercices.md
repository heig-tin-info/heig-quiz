# ADR-067 — Grading an exercise at hand-in

## Status

Accepted (2026-10-02, settled by the product owner after an incident in
production). Implemented by `gradeAtHandIn` and `reopenAttempt`
(`apps/api/src/modules/live/attempt.ts`), `standDownAutomaticGradings`
(`apps/api/src/modules/grading/service.ts`), the pass and the runner job of
`apps/api/src/modules/grading/jobs.ts`, and `GRADING_RUNNER_CONCURRENCY`
(`apps/api/src/config.ts`); the student's page by the sibling change to
`results/service.ts` and `@quiz/domain` (`feedbackGate`). Amends ADR-025 §4
and ADR-050 §3, and F-GRADE-01 of `docs/spec/02-exigences-fonctionnelles.md`.
Settles open question 50 of `docs/spec/06-questions-ouvertes.md`.

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

   Two guards keep a job sent before a reopen from writing over it. A pass
   run while the evaluation is live grades finished attempts only. A runner
   job carries the revision of the answer it was built from, and writes
   nothing — checked before the run and again before the write — when its
   attempt is no longer finished while the evaluation runs, or when the
   answer holds another revision: the hand-in after the reopen sent a job of
   its own.

5. **The runner is shared with the students.** The runner serves the
   grading and the students' Run clicks from one FIFO of its own
   (`RUNNER_CONCURRENCY`, `apps/runner/src/queue.ts`). An exercise graded
   at every hand-in sends grading runs while the class is still running
   code, so the API takes `grading.runner` jobs `GRADING_RUNNER_CONCURRENCY`
   at a time, one by default: a background grading holds at most one slot,
   and the rest stays the students'.

6. **What the student reads** (the sibling change, recorded here because it
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

## Rollback

Restore the condition "retakes enabled OR correction published" in
`gradeAtHandIn`. The supersede on reopen and the two guards are harmless
without it (nothing is graded before the close, so a reopen finds nothing
to stand down), and `GRADING_RUNNER_CONCURRENCY=1` is pg-boss's own default.
No schema change to undo.

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
