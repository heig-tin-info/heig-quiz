# ADR-142 — Practice of a released exam: redone blank, counted nowhere, when the teacher allows it

## Status

Accepted (2026-11-23, product owner Yves Chevallier, on issue #1037 raised by
a student: "the past series can be redone, the past quizzes cannot").

Scope: the practice switch (`settings.afterDue`) on an `exam`, the practice
attempts started on a released exam, and the readers of `attempts` that an
exam's practice rows could reach.

Relations: amends [ADR-122](ADR-122-entrainement-apres-l-echeance.md) §1,
§2 and §5 (the switch, what "over" is and the conditions of a practice,
extended to exams) and [ADR-025](ADR-025-plusieurs-tentatives-exercice.md)
(an exam keeps one OFFICIAL attempt). Reads
[ADR-041](ADR-041-entrainement-espace.md) §1 (an exam's cards, at its release,
for those who handed it in) and [ADR-124](ADR-124-un-exercice-montre-toujours-sa-correction.md)
§1 (`effectiveFeedbackPolicy`, unchanged for an exam). F-EVAL-11, F-EVAL-15,
F-EVAL-36, F-LIVE-01, F-RES-04, F-STAT-01.

## Context

An exercise stays open to practice after its due date (ADR-122). A student
asked for the same on the quizzes of the course: an exam whose results are
released is the best revision material there is, and today it can only be
read, never sat again. The drill (ADR-041) serves its questions one by one,
not the exam as it was set.

An exam differs from an exercise on two points. Its teacher may release the
results without the key (`showKey` off, or the policy `none`): unlimited
blank attempts, each answered with its points, would read that key out
question by question. And its sitting may be protected — Safe Exam Browser,
a kiosk station, an IP allow-list — which a revision at home cannot meet.

## Decision

1. **The gate is ADR-122's switch, extended.** `settings.afterDue`, its
   writer `PUT /evaluations/:id/after-due` (any member of the course,
   audited `evaluation.after_due`, editable at any state, outside the
   configuration lock) and its rule `afterDueOpen` (`@quiz/domain`,
   `afterDue.ts`) now take an exam; how each mode takes practice is one table
   of that file (`PRACTICE_BY_MODE`), which the rules, the guards and the
   practice's conditions read instead of testing the mode. On an exam the default is CLOSED: absent
   means `hidden`. A poll still has no switch (`409 after_due_locked`). Not
   "Allow drill", which is locked at the release (`allowDrillWritable`). The
   switch travels with the settings into a template and out of it, as the
   rest of the settings do; it does not survive a change of mode (each mode
   finds its own default). An exam's practice is open only while the exam is
   RELEASED and the switch is on (the table's `stateOpen`): a withdrawn release
   stops new practice attempts (`409 practice_refused`, `not_released`); an
   unfinished one may still be resumed, and its correction then waits for the
   results, through the feedback gate unchanged (`results_pending`).
2. **The correction is the exam's own policy.** A practice attempt reads
   exactly what the exam's stored policy shows (`feedbackOf`,
   `effectiveFeedbackPolicy`, invariant 4 unchanged): points only, never a
   grade. The switch may be turned on only when that policy is `on_release`
   with `showKey` (`practiceKeyShown`); otherwise `422 practice_key_hidden`.
   `showAnswer` is not asked: hiding the student's own answer reveals nothing
   to a practice, and the editor has no control for it. The open rule
   re-checks the policy on every read: a teacher who later hides the key
   SUSPENDS the practice, so repeated attempts never reveal points under a
   policy that hides the key. The stored `open` stays; the editor shows the
   switch on with "suspended", lets the teacher close it, and showing the key
   again reopens it. What a practice still shows under that policy is the
   points of each question, as an exercise's practice does (ADR-122): a
   hidden test case of a `code`, `circuit` or `blocks` question keeps its
   verdict and points in every correction (ADR-096), so repeated attempts
   tell which hidden cases a program passes, never their input or output.
3. **Who.** Only a student with a FINISHED OFFICIAL attempt on that exam
   (`officialAttempt`: not a practice one, not one a paper copy replaced) —
   `409 practice_refused`, `not_taken` otherwise. An absent or excused
   student does not practise it in this version. A teacher's staff seat
   follows the same rule, as a student (ADR-018).
4. **Conditions.** An exam's practice ignores its Safe Exam Browser, kiosk
   and IP allow-list settings: they protect the sitting, and a practice is
   not one (`sitRefusal`'s `practice`, on the practice entry and on every
   route of a practice attempt; the ready screen states no trusted client).
   A `seb` or `kiosk` session still never practises (ADR-122 §5). An
   exercise's practice keeps the allow-list, as ADR-122 §5 says.
5. **Defaults kept from ADR-122.** The duration rule (`practiceDurationS`:
   the exam's own time limit per student with the student's extra time, else
   eight hours); grading at the hand-in, by the model for what only a model
   grades when the platform has one (`gradeAtHandIn`, under the gateway's
   daily cap), else "not graded in practice"; a neutralized item stays,
   labelled not counted (ADR-108); unlimited attempts, one unfinished at a
   time, one new a minute. The released exams open to practice that the
   student handed in join the home's past list (« Entraînement sur
   les évaluations passées », one action per row); their blank print is never offered (the
   hand-out is an exercise's, and an exam's paper seed is its paper copies'
   own, ADR-125 §8).
6. **It counts nowhere.** ADR-122 §4 holds for an exam's practice rows:
   `officialAttempt` everywhere an exam was read as one attempt per student.
   The drill's cards of an exam (`finishedTakers`, at the release and the
   backfill) read official attempts only (the table's `practiceFeedsDrill`
   is false), so a practice row never gives a card, nor through it a key —
   kept although §3 already admits only those who handed the exam in, as a
   defence should that rule widen (to excused students, say). A paper copy entered on an exam ends only the
   student's official attempts. The results page counts the students who
   practised, apart from the table, as for an exercise.

## Consequences

- One switch and one predicate for both modes; no new table nor column.
- An exam keeps one official attempt per student (the exam's `attempts`
  may now hold several rows); every new reader that counts or ranks an
  exam's attempts must add `officialAttempt`, as ADR-122 already asks for
  exercises.
- A teacher who releases an exam with the key may now let the class sit it
  again blank; one who keeps the key cannot, by construction.
- The model may be called for each practice hand-in of an exam holding an
  essay, within the gateway's cap.

## Alternatives considered

- **Reuse "Allow drill".** It is locked at the release and decides the
  cards, not a whole sitting; a teacher may want either without the other.
- **Open every released exam by default.** It would reveal what a teacher
  who released the grade alone chose to keep closed (the reply on #1037).
- **Allow any policy, showing the points only.** The oracle ADR-122 §1
  described: unlimited tries read a hidden key out.
- **Let absent students practise.** Left for later: the exam's questions
  would reach students who never sat it, before the teacher decides it.
