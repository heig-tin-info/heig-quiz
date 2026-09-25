# ADR-025 — Several attempts on an exercise

## Status

Accepted (2026-09-25, issue #92, with `@quiz/domain/retake`,
`apps/api/src/modules/grading/kept.ts`, migration
`0015_exercise_retakes.sql` and `POST /evaluations/:id/retake`). Settles
open question 12 of `docs/spec/06-questions-ouvertes.md`.

## Context

F-EVAL-15 asks that an `exercise` may allow several attempts, keeping the
best or the last one. Until now the platform held exactly one attempt per
student per evaluation, and the database said so: the unique index
`attempts_evaluation_user_uq` on `(evaluation_id, user_id)` was the
mechanism of the idempotent `POST /evaluations/:id/attempt` (two tabs share
one seed and one deadline), and every reader — the student home, the live
grid, the grading panel, the results, the CSV, the release snapshot of
ADR-012, the statistics, the staff attempt of ADR-018 — joined `attempts`
on `(evaluation, user)` and expected one row.

The product owner answered the design questions on the issue: the teacher
chooses `best` or `last` per evaluation, and an optional maximum; after each
attempt the student sees the score only, not the correction; hand- and
LLM-graded answers simply wait for the teacher; statistics as simple as
possible; the student sees the kept score and the number of attempts.

## Decision

### 1. Numbered attempts, one unfinished at a time, in the schema

`attempts.attempt_number` (default 1) replaces the one-attempt index by
`attempts_evaluation_user_number_uq (evaluation_id, user_id, attempt_number)`.
A partial unique index `attempts_evaluation_user_open_uq (evaluation_id,
user_id) WHERE state IN ('not_started', 'in_progress')` keeps "at most one
unfinished attempt per student" a property of the database.

Entering stays idempotent: the first attempt is always inserted as number 1
with `ON CONFLICT DO NOTHING`, exactly as before. A retake inserts n + 1 the
same way, so two concurrent clicks create one row and the loser enters the
attempt the winner opened. Guests (polls) keep their own index and one
attempt.

The migration adds the column with its default, so every existing row is
attempt 1; the old index guaranteed one row per (evaluation, user), so both
new indexes hold on production data by construction, and the old index is
dropped last, in the same transaction.

### 2. The rule is the domain's, the setting is the evaluation's

`settings.retakes = { enabled, keep: "best" | "last", maxAttempts | null }`
(absent = one attempt, so stored evaluations parse unchanged). It is a
structural setting: frozen once an attempt exists and while the evaluation
runs, like the rest of `settings`. The server refuses `enabled` on an exam
(`422 retakes_not_allowed`).

`retakeRefusal` (`@quiz/domain`) says whether a student may start another
attempt now: the exercise allows retakes, the evaluation is `running` (not
paused, not closed), its common end (`closesAt`) has not come, the student
has a first attempt, the latest one is finished (`submitted` or `expired`),
and the maximum — which counts the first attempt — is not reached. The
server applies it on `POST /evaluations/:id/retake` (`409 retake_refused`
with the reason); the student home reads the same answer to offer the
button. The access code is not asked again (the first attempt admitted the
student); the network allowlist is, like on every entry.

A retake is a new row with a new seed: a new item order and newly shuffled
choices on the same frozen question versions, blank, started at once.

The rule is read again inside a transaction that holds the evaluation row
`FOR SHARE`, and the attempt is inserted already `in_progress` in that same
transaction; `closeEvaluation` flips the state to `closed` BEFORE it expires
the open attempts. The flip needs the row lock, so a retake racing the
teacher's Close either commits first and is expired with the others, or
reads `closed` and is refused — never a blank attempt left open on a closed
evaluation, graded 0 at the close and then kept as the "last".

### 3. The CURRENT attempt is the latest; the attempt that COUNTS is the kept one

Everything that serves a student or shows a live row reads the latest
attempt: `attemptOf`, the student home, the lobby count, the live grid (one
row per student, with an `attemptCount` and a badge). Everything that is a
RESULT reads the kept attempt: `keptAttempt` (`@quiz/domain`) picks, among
the finished attempts, the best score (a tie goes to the latest) or the
last; with no finished attempt it falls back to the latest. The results
table, the grade, the CSV, the release snapshot (ADR-012 freezes the kept
attempt's grade and id), the student's result cards and the per-question
statistics all go through `keptAttempts` / `studentAttempts`
(`grading/kept.ts`).

Statistics per question count the kept attempts only — one per student, the
ones the grades come from. It is the simplest consistent choice; learning
curves over every attempt can come later without a schema change.

### 4. Every attempt is graded; the student reads the score only

An attempt of an exercise with retakes is graded alone as soon as it ends —
handed in, expired by the ticker, or closed by the teacher — by the usual
pass (`grading.evaluation` with `attemptIds`), because its score is what
the student decides a retake on. Deterministic types are validated at once;
hand- and LLM-graded answers stay proposals for the teacher, and the score
says `pending`. The close of the evaluation grades every attempt as before.

While such an exercise is open (`lobby`, `running`, `paused`), the feedback
of a finished attempt is `available: false, reason: "retakes_open"` with the
attempt's validated points and nothing else — no item, verdict, answer or
key — whatever the feedback policy says, including `none`: enabling retakes
is the teacher's consent to the score, without which a retake is pointless.
Once the evaluation is closed the policy applies unchanged: `immediate`
shows the correction then, `on_release` at release. The correction of
attempt 1 would otherwise be the key of attempt 2.

### 5. Teacher screens

The live grid shows each student's latest attempt, badged `attempt n`, and
its success rates count those rows only. The grading panel lists every
attempt; a student with several is labelled `· #n` (a number, readable in
both languages). Reopening an attempt is refused on an exercise with
retakes (`409 retakes_enabled`) and not offered in the grid: the student
retakes instead, and a reopened attempt that was already graded would keep
its first grades. The staff attempt of ADR-018 is unchanged: its reset
deletes every attempt of the teacher's own seat.

Closing ONE attempt from the grid (F-LIVE-11) stays available, and on such
an exercise the student may then start a retake of their own. This is
intended: closing a single attempt ends that attempt, not the student's
right to retake — the teacher who wants a student to stop closes the
evaluation, or sets a maximum.

The student home offers **Try again** as the card's one action; under
`keep: "last"` it asks first ("your last attempt counts, even if lower"),
because a retake can lower the result. The kept score on the card follows
the same visibility as the feedback page: shown while the exercise takes
retakes, and after its close only when the feedback policy lets the results
through (`scoreVisible`).

## Consequences

- Readers that join `attempts` for one row per student now say which one:
  `isLatestAttempt` (a `NOT EXISTS` on a higher number) in the joins of the
  student home and of the staff roster, `ORDER BY attempt_number DESC` in
  `attemptOf`. A new reader must choose too.
- The state column is in a partial index predicate, so a state change is no
  longer a HOT update; physical row order moves more. One test that relied
  on it (two attempts created on the same instant) now spaces them.
- A student who used their last attempt, or whose laptop died mid-attempt,
  cannot be reopened on such an exercise; the teacher raises nothing today
  (settings are frozen). Acceptable for exercises; revisit if asked.
- The home card, not the end-of-attempt screen, carries the Retake action:
  the player (`Player.tsx`, `ClosedScreen.tsx`) is unchanged. *Superseded
  by the addendum below (issues #120, #121).*
- Reopening an attempt is refused on an exercise with retakes
  (`409 retakes_enabled`), and the grid does not offer it.
- The evaluation list counts STUDENTS who took the evaluation
  (`count(distinct owner)`), not attempt rows.

### Addendum (2026-09-25, issues #120, #121): the score page carries the retake

On such an exercise, the end of an attempt — handed in, or its time up —
no longer shows the hand-in screen ("your answers are with your teacher",
wrong in this mode): the player forwards to the student's results page,
which shows the score and offers **Try again** as its one action, or says in
a line why no other attempt may start (maximum reached, the common end
passed, the exercise paused) — or offers to resume the attempt already open.
A teacher's close keeps the hand-in screen: no retake follows it. Exams and
exercises without retakes are unchanged.

The results page does not recompute the rule: `FeedbackPending` carries
`retake` (`RetakeStatus`) next to the score while the reason is
`retakes_open`, with `refusal` evaluated by `retakeRefusal` exactly as
`POST /evaluations/:id/retake` does. The home card and the results page
share one client implementation (`apps/web/src/student/retake.ts`): the
confirmation under `keep: "last"`, the call, and the hand-over to the
attempt route. That hand-over is the fix of #120: `/take/:id` reads its
attempt through a query cached per evaluation, so the entry of the attempt
just handed in was rendered first, and the player — bound to that attempt's
id — never moved to the new one. The retake now drops every cached entry of
the evaluation and seeds the retake's own answer in its place, and the
player is keyed by the attempt id, so a new attempt always mounts a new
player (state, autosave and stream topic).

### Rollback

Migration `0015` is not reversible by reverting the code alone. Reverting
the application after it ran needs a DOWN migration that drops
`attempts_evaluation_user_open_uq` and `attempts_evaluation_user_number_uq`,
recreates `attempts_evaluation_user_uq (evaluation_id, user_id)` and drops
`attempt_number`. Recreating the one-attempt index FAILS as soon as one
retake exists: the extra attempts must be deleted (or moved aside) first,
keeping the kept attempt of each student, which is a decision about
students' results and not a mechanical step. The old code does not run on
the new schema at all: its `ON CONFLICT (evaluation_id, user_id)` target has
no matching unique index, so every first entry into an evaluation would fail.
A rollback is therefore a migration, never a plain redeploy.

## Alternatives considered

- **A `superseded` flag or a `current` boolean** instead of a number: the
  number orders the attempts, labels them for the teacher and makes the
  retake insert idempotent by itself; a flag needs a two-row update.
- **Keeping one row and resetting it** for a retake: loses the earlier
  answers and their grades, which the `best` rule needs.
- **Requiring `immediate` feedback for retakes**, or showing the correction
  between attempts: the product owner chose the score only; the correction
  would give the next attempt its key.
- **Statistics over every attempt**: closer to "how students learn", but
  the success rates would no longer be those of the grades; left for later.
- **Grading retakes only at the close**: the student would retake blind.
