# ADR-122 — Practice after the due date: an exercise stays open, its practice attempts count nowhere

## Status

Accepted (2026-11-02, product owner Yves Chevallier, on issue #985 raised
by the student noah-missegue: "once a series is closed I can no longer redo
it to revise"). Migration `0125_attempt_after_due.sql`.

Scope: an `exercise` that is over (closed, being graded, released), the
practice attempts started on it, and every reader of `attempts` that counts,
grades or shows the class.

Relations: amends [ADR-025](ADR-025-plusieurs-tentatives-exercice.md) §1
(retakes only while running; the kept rule), [ADR-067](ADR-067-correction-a-la-remise-des-exercices.md)
(graded at hand-in only while running), [ADR-086](ADR-086-planifiee-ou-en-direct.md)
(what the due date of an exercise means) and [ADR-091](ADR-091-reprise-partielle-d-un-exercice.md)
(no partial retake after the due date). F-EVAL-04, F-EVAL-11, F-EVAL-15,
F-EVAL-36, F-LIVE-01, F-RES-04, F-LLM-03.

Amended 2026-11-02 by [ADR-124](ADR-124-un-exercice-montre-toujours-sa-correction.md): §1 — the default of `afterDue` is open on every exercise; the oracle that kept it hidden under a hidden key is gone, since an exercise always shows its key, and the evaluation no longer carries `afterDueSource`. §7 — a practice attempt shows the whole correction at its hand-in, points only, never a grade; no score-only page remains.

Amended 2026-11-03 (#1004), scope: §9 only — see the amendment note there.

Amended 2026-11-03 by [ADR-125](ADR-125-copies-papier-pdf-typst.md) §12, scope: §4 only — `officialAttempt` also leaves out an attempt a paper copy replaced (`superseded_by is null`); `isLatestAttempt` and `attemptOf` are unchanged, the paper attempt being the student's latest.

## Context

An exercise is practice by nature, yet its due date closed it for good: once
the ticker closed it, a student could read their own attempt and nothing
else. Revising a series the week before an exam meant asking the teacher to
duplicate it. The drill (ADR-041) serves the questions one by one; it does
not replay the series as a whole, with its order, its timing and its score.

The due date, however, carries real weight: the ticker closes the exercise,
the reminders fire on it, the results, the release, the statistics and the
debrief are computed on what was handed in by then, and the gradebook reads
the kept attempt. None of that may move.

## Decision

1. **A switch, with a default.** *(Default amended by ADR-124: open on every exercise.)* `settings.afterDue: "open" | "hidden"`, on
   an exercise only. Absent, the default is `open` only where the feedback
   policy shows the answer key (`showKey`, under a policy other than
   `none`); everywhere else it is `hidden`. The reason is an oracle:
   unlimited blank attempts, each answered with its total score (the score
   alone under `on_release` before the release) or with each question's
   verdict and points (the review under `immediate`, which carries them
   whatever `showKey` says), let a student try one answer after another and
   read the key the teacher kept hidden, question by question. The product
   owner set the rule for `none`; it is extended, on the same grounds, to
   every policy that hides the key (orchestrator's decision, 2026-11-02). A
   teacher who opens the practice explicitly under a hidden key accepts that
   oracle. Every past exercise that shows its key reopens by the default,
   with no data migration. The rule is one pure function, `afterDueOpen`
   (`@quiz/domain`, `afterDue.ts`); the evaluation carries its value and
   whether it is the default (`afterDueOpen`, `afterDueSource`), so the
   editor never derives the rule again. An
   exercise that asks for a trusted client (Safe Exam Browser, a kiosk
   station) is treated as hidden. The switch is a visibility switch, not a
   frozen setting: it has its own writer (`PUT /evaluations/:id/after-due`,
   any member of the course, audited `evaluation.after_due`), editable at
   any state, the close and the release included, outside the configuration
   lock — like "Allow drill" (ADR-041 §10).
2. **What "after due" is.** An attempt created while the evaluation is over
   (`isEvaluationOver`: closed, grading, released) — by state, not by clock.
   It is stored on the attempt: `attempts.after_due`, written once at
   creation. Its number follows every attempt of the student's, so the
   unique index stays whole.
3. **Its end.** The exercise's own time limit per student (a `duration`
   timing) and the roster's extra time on it, never cut at `closes_at`,
   which has passed; otherwise eight hours (`practiceDeadline`). The ticker
   expires it like any attempt, and the autosave gate follows the attempt's
   own deadline (invariant 5: `deadline + 3 s`, `410 attempt_closed`).
4. **It counts nowhere.** Never the kept attempt (`keptAttempts`,
   `studentAttempts`), the grade, the gradebook, the release snapshot
   (`released_grades`), the class statistics and the debrief, the pool's
   question statistics, the number of attempts of a retake rule, the
   grading table, its progress and its steps, the regrade and the close's
   pass, the live dashboard, the integrity incidents, the teacher's lists.
   One SQL predicate says it, `officialAttempt` (`db/live.ts`), and
   `isLatestAttempt` and `attemptOf` ignore a practice attempt: the
   student's current attempt stays the official one. A practice grading on
   a released exercise never marks it "modified after the release". The
   results page tells the teacher how many students practised, apart from
   the table.
5. **How it starts.** `POST /evaluations/:id/practice` writes nothing: it
   resumes the student's unfinished practice attempt, or answers the ready
   screen of a new one, its conditions shown again (F-EVAL-33, ADR-076).
   `…/practice/start` creates one: unlimited, one unfinished attempt at a
   time (the partial index of the schema), at most one new attempt a minute
   (`429 rate_limited`); refused `409 practice_refused` with a reason —
   `hidden`, `not_over`, `archived` (an archived classroom takes no write),
   `unfinished` (a stale official attempt). Always a whole blank attempt on
   a new seed, never a partial retake (ADR-091). The network allowlist
   applies, as on every sitting route; the two routes are not `SITTING`: a
   `seb` or `kiosk` session never practises. The integrity journal is off:
   no integrity event of a practice attempt is stored
   (`storesIntegrityEvent`); its other journal entries (a reconnection) are
   kept like any attempt's.
6. **Its grading.** Automatic items are graded at the hand-in, whatever the
   evaluation's state, and so is an attempt the ticker expires. An item only
   a model can grade (an essay, a short answer judged by the AI, a rich
   answer) is **graded by the model, automatically, when the platform has
   one**, through the existing pipeline (the `grading.llm` job, off the
   request path): its successful reply is the practice result, written
   validated, shown to the student, never in the teacher's queue and never
   checked by a teacher. This was the product owner's explicit choice,
   knowing it costs model calls (billed like any grading of the exercise)
   and shows unvalidated points. Without a model the cell stays not graded:
   "not graded in practice".
7. **What the student reads.** *(Amended by ADR-124: the whole correction at the hand-in, whatever the policy.)* The feedback gate unchanged (`feedbackGate`,
   no retake open on an exercise that is over): under `immediate` the key
   and the explanation at hand-in, under `on_release` once released or the
   correction published (ADR-050) — the score alone before that; under
   `none`, hidden by default, and nothing at all, not even the score, if a
   teacher opens it anyway. Under a policy that shows the score or the
   verdicts but not the key, the practice is hidden by default (§1); opened
   explicitly, it reads exactly what the policy shows. Points only,
   labelled practice, never a grade.
   Everything goes through the student view (`toStudent`, `studentFeedback`,
   invariant 4).
8. **The drill.** A practice attempt that ends through `endAttempts` feeds
   the drill like any hand-in (`cardsAtHandIn`). The drill's key rule reads
   the student's official latest attempt, so a practice attempt in progress
   never hides a key the exercise already shows.
9. **The screens.** The student's home gains "Past series" (« Séries
   passées »): the exercises of their classrooms over and open to practice,
   each with Practise (« S'entraîner »), Practise again (« Recommencer ») or
   Resume, and the points of their latest practice. A practice opens on its
   ready screen, then the player, marked practice; its results page says
   practice and offers another. The exercise's editor holds the switch,
   with the default explained. *(Amended 2026-11-03, #1004: the student's
   classroom page shows the same Past series on its Activities tab,
   narrowed to the classroom and without the classroom's name on each row,
   after Upcoming and before Past. An exercise listed there stays in Past
   too: the Past series row carries the practice, the Past card the
   official attempt — its status, its results, its retakes.)*
10. **Exports.** The results CSV, the export factory (ADR-121) and the
    personal export (ADR-112) read the kept attempt or the Grades page:
    practice attempts are excluded from all of them, not labelled.

Deferred: an official attempt left `not_started` in a lobby, which the
close does not end, blocks practice (`409 practice_refused`, `unfinished`,
the student told to ask the teacher); it is never expired by the practice
route, since an expired official attempt would enter the kept attempt and
the results — a teacher's tool to clear it is open. The drill's trigger on
"saw the correction" of a practice attempt;
disabling the Safe Exam Browser and kiosk options on an exercise (a separate
ticket); re-grading a practice attempt when its item is regraded — a regrade
stands down and re-grades the official attempts only.

## Consequences

- One column and one predicate, rather than a table of their own: a practice
  attempt reuses the player, the autosave, the runner, the grading pass and
  the student view whole. The cost is the discipline of the predicate: every
  new reader of `attempts` that counts or ranks must add `officialAttempt`,
  and the latest-attempt readers go through `isLatestAttempt` or `attemptOf`.
- An exercise closed before this change reopens to practice under its
  default the day it ships, unless its policy is `none`.
- The model may be called for each practice hand-in of an essay exercise;
  the daily cap of the gateway (ADR-058) bounds it.
- A practice attempt can block the deletion of the evaluation as student
  data does (the deletion's role counts it), and a `closed → draft` reopen
  of the evaluation, which needs no attempt.

## Alternatives considered

- **A separate table of practice attempts.** Answers, gradings, the journal
  and the runner all hang off `attempts`; a copy of each, or a polymorphic
  owner, for one boolean of difference.
- **Reopening the exercise past its due date.** It would move the kept
  attempt, the grade and the release, which is exactly what the due date
  protects.
- **The drill only.** It replays questions one by one; the student asked for
  the series as it was set.
- **No model in practice.** Essay series would read "not graded" for good;
  the product owner chose the model, its cost and its unvalidated points.
