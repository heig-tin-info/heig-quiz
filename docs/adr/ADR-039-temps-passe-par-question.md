# ADR-039 — Time spent per question: a dwell measured by the server

## Status

Accepted (2026-09-29, decided by the teacher who owns the product, who
delegated the choice of the metrics; with `closeShown` and `endAttempts`
in `apps/api/src/modules/live/dwell.ts`, `reportShown` in
`live/autosave.ts`, `quantile` / `spread` / `shownTimeSpread` /
`DWELL_IDLE_CAP_MS` in
`@quiz/domain/stats`, `TimeStats` in `@quiz/contracts/stats`, and the
columns of migration `0034_answer_dwell`). Amends ADR-038 (§2, the "not
reached" bias; §8, the step it announced). Revises F-STAT-01 (docs/spec/02).

Amended 2026-10-09: the Rollback section is removed (the runbook owns operational procedures).

Amended 2026-10-16 (#897 E3, open question 60), decided by the product owner (option (b) of
the question, 2026-10-16): the time of targeted revision
([ADR-115](ADR-115-revision-ciblee-par-notion.md) §6) feeds a SEPARATE series, §6b, never
the exam series of §6; §8 widened to it. Two points are taken by assumption, for the
product owner to change (§6b, Privacy): that anonymous aggregate sits in the pool's panel,
across classrooms; and its residual differencing risk is accepted — without a mean no
exact recovery always works, but the median, and sometimes a quartile, compared before and
after one student's round, can still equal that student's first-try time or bound it. Code: `firstRevisionPassesOf` in `apps/api/src/modules/stats/service.ts`,
`REVISION_TIME_MIN_STUDENTS` / `shownRevisionSpread` in `@quiz/domain/stats`,
`RevisionTimeStats` and `QuestionStats.revisionTime` in `@quiz/contracts/stats`. No
migration.

## Context

ADR-038 gave a question its success rate and announced a second step: the
time students spend on it — what a teacher needs to size a test
(F-STAT-04) and to spot a question that eats a quarter of the exam. Nothing
measured it:

- the player shows ONE question per screen, in every navigation mode, and
  posts `POST /attempts/:id/position { itemId }` once per move — a bookmark
  for the reload (F-LIVE-06), never read as a time;
- `answers.first_seen_at` is written on the first save or flag, not on
  display, and nothing reads it;
- the attempt log (F-EVAL-13) records visibility and focus, for the teacher's
  eyes, rate-limited and unordered with the position.

A time measured in the browser would be the student's clock, which
invariant 5 forbids for anything the server decides. ADR-038 also left one
bias open: a question the student never reached counts 0 in `p`, like one
they saw and left blank, which drags the last items of a long timed exam
down.

## Decision

### 1. One signal: what is on screen

`PositionBody` becomes `{ itemId: uuid | null }`. An item id is "this
question is on screen from now"; `null` is "no question on screen" (the tab
hidden, the player left for the home page). The server keeps `last_item_id`
on a `null`: the bookmark is untouched. An old client that never sends
`null` still works; it only overcounts, within the cap of §3.

The player sends the item on every move, `null` (with `keepalive`) when the
tab hides and when the player unmounts while the attempt runs, the item
again when the tab comes back, when the attempt resumes and when the event
stream reopens. A pause or a close sends nothing: the server ends the
interval by itself (§4). The client deduplicates nothing: a re-reported
question is a no-op on the server (§2), and a `null` with nothing open
changes nothing.

### 2. Intervals on the server's clock, summed in the answer row

The attempt holds at most one open interval: `shown_item_id` since
`shown_since`, both null or both set (`attempts_shown_ck`). A report ends
the open interval at the server's `now` and, for an item of a RUNNING
evaluation on an `in_progress` attempt, opens the next one. The interval is
credited to `answers.dwell_ms`, an accumulator; there is no attempt-log row
per interval, and the attempt log is not read for the time.

A report of the item already open changes nothing: a re-sent position never
cuts an interval in two. A report must name an item of the attempt's own
evaluation, or it is a `404` that writes nothing — which also closes a hole
the bookmark had: any `evaluation_items` id used to pass.

The report takes the same gate as the attempt log (`assertOpen`): it is
accepted during a pause, refused with `410` past `deadline + 3 s`. Inside
its transaction it locks the attempt row, then reads the attempt's and the
evaluation's states in statements of their own — under READ COMMITTED their
snapshot is taken once the lock is held, so a pause or a close that
committed while the report waited is seen, and no interval is opened behind
it. The evaluation row is read, not locked: the resume locks the evaluation
and then the attempts, and the reverse order would deadlock.

### 3. The idle cap, not a flat cap

An interval is credited

    max(0, min(end, deadline_at, max(since, answers.updated_at) + CAP) - since)

with `CAP = DWELL_IDLE_CAP_MS` = 10 minutes. A question left on screen in a
forgotten tab counts at most ten minutes after the later of its display and
the student's last write to it; a student who keeps typing is never cut.
The autosave already stamps `answers.updated_at`, so the cap costs the hot
path nothing, and the flush never touches `updated_at` itself.

A flat cap per interval would either cut a long honest essay or let an
abandoned tab count half an hour; a heartbeat would add a write every few
seconds per student to measure the same thing.

### 4. Where an interval ends

`closeShown` is the only place an interval ends: one statement that locks
the attempt rows (in id order), clears the pair and credits the answer
rows. It runs at the next report, at the pause (every open attempt), and
inside `endAttempts`, the one way an attempt ends — the submission, the
teacher's close of one attempt, the close of the evaluation and the
ticker's expiry. `endAttempts` locks the `in_progress` rows it targets in
id order, flushes their intervals, then writes their state, in one
transaction: the ticker and a teacher's close lock in the same order and
cannot deadlock each other. A resume, a reopen
and a staff reset do nothing: the players report again.

The DEADLINE clamps the credit: the grace window is for the network, not
for thinking. A manual timing has no deadline and no clamp. There is no
heartbeat, and a lost SSE connection closes nothing: the interval ends at
the next signal the server receives, bounded by the cap.

Lock order: the attempt row first, then the answer row — the order of every
transaction that touches both. The autosave touches only the answer row.

### 5. Displayed, and not reached

The first report of a question inserts its answer row if there is none
(`payload` JSON `null`, revision 0) and stamps `answers.first_shown_at`; a
write to a question stamps it too (`coalesce`), whatever the player
reported. A row created by a report publishes its cell: the live grid's
"seen" now means the question was on screen. The first autosave (revision
1) still wins over the revision-0 row.

`attempts.display_tracked` says the attempt reported what was on screen:
false for every attempt that existed before migration 0034 (the column is
added with default false, then the default becomes true).

In the success rate of ADR-038, on a TRACKED attempt, a question whose row
is missing or never shown is LEFT OUT: it was not reached. A blank the
student saw still counts 0. A legacy attempt keeps the old rule (0). This
is the remedy ADR-038 §2 announced.

### 6. What the statistics show

The time is its own series: the `dwell_ms` of every answer of an EXAM, on a
finished, tracked attempt of a student account that is not a staff seat,
started at or after the question's `stats_since`, with a first display and
a dwell above zero — blanks and skips included, because the time spent on
a question is what the exam cost, whatever the answer. There is no kept
attempt to pick (an exam has one attempt) and no grading needed.

Exercises are tracked like exams — there is no mode branch in the hot
path — and never counted: an exercise is done over days, between other
things.

Shown: the median with P25–P75 (type-7 quantiles), the mean — which
F-STAT-04 needs, since means add up and medians do not — and `n`, in whole
seconds. No minimum, maximum or spread (N-DATA-06). Its own threshold,
`QUESTION_TIME_MIN_N` = 10 timed answers; below it `time` is `null` while
`n` and `p` show, and the question's entry still exists only when the
success rate has its ten answers.

*(Amended 2026-10-16, §6b: the entry also exists when the time in targeted
revision qualifies alone; `n`, `p`, the time and the discrimination are
then null.)*

### 6b. The targeted-revision series

*Amendment 2026-10-16 (#897 E3, open question 60, product owner's option (b)).*

The time per question of a round of targeted revision (`drill_revision_answers.time_ms`,
ADR-115 §6) is its own series, shown beside the exam series of §6 and never merged into
it: a student who revises has already met the question and may see its key, so their time
says how long a known question takes to re-answer, not what it costs in an exam.

- **The value.** Per question, over `drill_revision_answers` joined to `drill_cards` (a
  card is unique per student and question, so one card is one student): **one value per
  student**, the `time_ms` of that card's earliest ANSWERED first pass (`pass = 1`), right,
  partial or wrong, among the passes served at or after the question's `stats_since`; a
  zero time is left out, a time at the idle cap kept. A second pass, or the first pass of a
  later round, adds nothing: it follows a key just seen in a round, and one value per
  student keeps `n` a count of students. The reset (F-STAT-05) covers this series by the
  pass's `served_at`, as it covers the exams by the attempt's start. Rounds before an
  opt-out, and the rounds of an archived classroom, count; a card the teacher removes
  takes its passes, and its value, with it.
- **The threshold.** `REVISION_TIME_MIN_STUDENTS` = `QUESTION_STATS_MIN_N` = **10
  distinct students**, applied by the server (ADR-038 §4): below it `revisionTime` is
  null. The shape is `RevisionTimeStats`, the `TimeStats` of §6 **without the mean**, `n`
  counting students: the median with P25–P75, whole seconds, nothing else (N-DATA-06). No
  mean, because a mean beside `n` gives back exactly the one value a new student adds
  (Privacy below); nothing adds this series up anyway (F-STAT-04 sums the exam means).
- **The entry.** A question's entry exists when EITHER series qualifies. With fewer than
  ten exam answers, `n` and `p` are null, and so are the exam's time and discrimination;
  its distractors are absent. The pool's filters (F-STAT-03) and the similar questions
  read the exam figures only: an entry carried by this series alone is a question without
  statistics there.
- **The labelling.** In the question's statistics panel, a block "Time in targeted
  revision", last, with one line: "First try per student, on a question they had already
  met and whose key they could see. Not an exam time, not comparable to it."; below the
  threshold, "Shown from {min} students.". Not a column of the pool's table, not a filter;
  never summed into "Generate a quiz" (F-STAT-04). The MCP tool `get_pool_question_stats`
  says that `revisionTime` is not an exam time and must never be added to a test's
  duration.
- **Privacy.** An anonymous per-question aggregate of at least ten distinct students may
  sit in the pool's panel, read by the pool's readers across classrooms (ADR-038 §5),
  like the exam aggregates (settled question 28 (l), N-DATA-06), while a classroom's drill
  rows, and every per-classroom read of the drill, stay with that classroom's staff (28
  (j), ADR-085 §8). No route returns a time of one student.
  **The residual risk is not ADR-038's.** A classroom's staff see, per student, when they
  last revised (ADR-115 §9) and are often readers of the pool: comparing `revisionTime`
  just before and just after one known student's round (`n` from 10 to 11), they could tie
  the change to that student, whose time ADR-115 §9 promises never to show. A mean would
  give the value back exactly, in every case (`11·mean₁₁ − 10·mean₁₀`); so the series
  carries **no mean**. That removes the exact recovery that always worked, not the risk:
  the quantiles interpolate, so at an odd `n` the median IS one of the values, and a new
  time that falls between the old middle values becomes the published median; from an
  odd to an even `n`, `2·median_new − median_old` gives it back near the middle; the
  quartiles leak likewise at some `n`. Compared before and after one student's round, the
  median, and sometimes a quartile, can therefore equal that student's first-try time, or
  bound it to an interval between published values.
  *Taken by assumption, the product owner may change them:* (1) the anonymous
  cross-classroom aggregate in the pool's panel, although ADR-085 §8 kept the confidence
  2×2 out of that panel for its readers span other classrooms — the difference is that
  the 2×2 reads classroom rows by classroom, while this series is the question's anonymous
  aggregate over every classroom, like the exam figures; (2) the acceptance of this
  residual risk: a classroom's staff may sometimes read, or bound, one of their students'
  first-try time from the change of the median.

### 7. Who is measured

Never a delegated session (ADR-034): somebody acting as the student moves
the bookmark and nothing else — no interval, no sign of life. A staff
member's test walk is measured and left out at read time, as in ADR-038.

### 8. Privacy

`dwell_ms`, `first_shown_at` and the open interval never leave the server:
no route returns them, to the student or to the staff; only the aggregates
of §6 and of §6b do, above their thresholds. *(Widened 2026-10-16: §6b,
the time of targeted revision, `drill_revision_answers.time_ms`, likewise.)*

## Consequences

- Zero extra writes on the autosave path: its upserts only gain the
  `first_shown_at` coalesce. A position report is one short transaction on
  the attempt row, a few statements.
- The live grid's "seen" becomes truthful: a question on screen shows as
  seen before anything is typed in it.
- Two visible windows of the same attempt misattribute: the last report
  wins. A tab becoming visible re-reports its question, so the error lasts
  as long as both are on screen; SEB (ADR-027) excludes it for exams that
  need it.
- The first deploy: a player loaded before it never sends `null`, so its
  intervals end at the next move or the end of the attempt — overcounting
  at most the cap per interval, on attempts that are tracked from the
  migration on.

## Alternatives considered

- **A client-measured time.** The browser's clock, sent by the browser:
  invariant 5 forbids it, and it is trivially forged.
- **A heartbeat.** A write every few seconds per student during an exam, to
  learn what the idle cap already bounds.
- **One attempt-log row per interval.** A second log with its own rate
  limit and ordering problems, re-aggregated at every read; the
  accumulator is what the statistics read.
- **Closing on SSE disconnect.** A flaky network would cut honest
  intervals; the next report and the cap bound the rest.
- **Exercises included.** Their time spans days of other activities.
