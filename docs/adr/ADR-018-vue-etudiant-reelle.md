# ADR-018 — The real student view, and the teacher's own test attempt

## Status

Accepted (2026-09-22, asked for by the product owner).

## Context

The product owner asked, in these terms: from an evaluation, a button that
opens the REAL student view — exactly what the student gets — the way
`~/heig-classroom` does, so that testing a quiz means walking it rather than
reading a rendering of it.

Three things already existed, and none of them is what was asked for:

- **"Student preview"** (`PreviewSheet.tsx`, `POST /evaluations/:id/preview`)
  renders every item through its type's `Player` in `readOnly`, seed 0, with
  no attempt row anywhere. It answers "did I configure the right questions?".
  It cannot answer "does the lobby open, does the milestone lock, does the
  countdown say what I think, does the submit land".
- **"Join as student"** (`POST /classrooms/:id/self-enroll`) gives the teacher
  a roster seat flagged `staff`, on the classroom page.
- **"Switch to student view"** (`App.tsx`, `VIEW_AS_KEY`, the banner in
  `Shell.tsx`) turns the teacher UI off, and returns to the teacher HOME.

So the walk was already possible and took four deliberate steps in three
different places, one of which is a page the teacher was not on. And
`participantOf` already admits a staff seat, so `/take/:id` already served a
teacher the real lobby, the real player and the real feedback — which is
exactly why the question this ADR has to settle is not "can they take it" but
**what happens to the attempt they leave behind**.

That attempt is a row in `attempts` like any other. It gets graded by the real
grading pass, it lands in the grading panel, and — before this change — its
gradings were counted in every success rate (`itemViews`, `successRateOf`) and
its answers in every distribution (`byQuestion`), while `computeResults` and
`dashboardView` filtered the roster on `staff = false` and so never showed the
row to the person who created it. The teacher's rehearsal was therefore
invisible where they wanted to see it and present in every statistic where
they did not.

And `POST /evaluations/:id/attempt` is idempotent on
`(evaluation_id, user_id)`, by design (two tabs, one seed, one deadline). A
teacher who submits their test attempt has tested that quiz once, for ever.

## Decision

1. **One button, on the evaluation page, that does the whole walk.**
   "View as student" sits beside "Student preview" as a SECONDARY action —
   the primary of each step of that screen stays what it is. It self-enrols
   when the teacher holds no seat (after a confirmation naming what it does),
   switches the app into student view, and navigates to `/take/:id`. Nothing
   of the student flow is re-implemented: it is the student's route, the
   student's components, the student's payloads.

2. **The student view remembers where it was entered from.** The banner's
   "Back to teacher view" returns to the evaluation, not to the teacher home.
   The return route is held beside `quiz-view-as` in `localStorage`
   (`quiz-view-as-return`, a path), so a reload in the middle of the walk —
   which an exam player does routinely — does not lose the way back. One
   source of truth: `studentView.tsx` owns both, `App.tsx` reads it, `Shell`
   and the command palette call it.

3. **A staff attempt is SHOWN wherever attempts are listed, and BADGED.**
   The live dashboard, the grading panel and the results table all carry it,
   each with a `staff: boolean` on the row (`DashboardRow`, `GradingEntry`,
   `ResultRow`), drawn with the same `GraduationCap` "Staff" badge the roster
   table already uses. A teacher testing their quiz wants to watch their own
   row fill in, and wants to see how their own answers were graded; hiding
   the row would be hiding the thing they are testing.

   A staff seat that took NO attempt is not listed. Otherwise every teacher of
   the course would appear in the grid of every quiz they never opened.

4. **A staff attempt counts in NOTHING.** Not in the lobby denominator
   (`enrolledCount`, which already excluded staff seats), not in the
   completion of a question, not in its success rate, not in the class
   statistics or the histogram, not in the frozen snapshot written at release
   (`released_grades`), and not in the per-question answer distributions of
   the class debrief. One query, `staffAttemptIds`, is the single definition
   of "which attempts are a teacher's", and the dashboard, the grading panel
   and the results all read it, so the three screens cannot disagree.

5. **The CSV export drops the row rather than marking it.** This is the one
   place where "show it, badged" is refused, and deliberately. The export is a
   grade sheet: it is read by a human, pasted into another sheet, and
   sometimes imported by an administration. A marker column is a footnote that
   every downstream reader has to honour, and the first one who does not turns
   a rehearsal into a student's grade. The row is on the SCREEN, badged, where
   the person who created it is the person reading it. `F-RES-02` says the
   export is the class list; a teacher is not on the class list.

6. **A teacher may reset their OWN staff attempt.**
   `DELETE /app/api/evaluations/:id/attempt` deletes the caller's attempt and
   answers `{ deleted }`. Three conditions, all of them LOADED and not checked
   afterwards (invariant 6): the caller is on the course's staff (the guard),
   the seat they hold in the classroom is a `staff` seat, and the row deleted
   is keyed on their own user id. A student's attempt is unreachable from this
   route in any state, and a teacher cannot reach a colleague's. The dependent
   rows — answers, journal entries, gradings — go with it through the
   `ON DELETE CASCADE` the schema already declares. Audited as
   `attempt.staff_reset`.

   The `410 attempt_closed` gate of §4.7 does not apply: that gate protects a
   student's exam from a late write. This is a teacher erasing their own
   rehearsal, and there is nothing to protect it from.

7. **Nothing about the student path changed.** `participantOf` admitted a
   claimed seat before and admits one now; `toStudent` is still the one exit
   for question content (invariant 4); the server still owns the clock, so a
   teacher's test attempt is closed by the ticker exactly like a student's.
   The teacher sees no more than a student does while they are in there —
   which is the entire point of walking it.

## Consequences

- `EvaluationDetail` gains `self: { seat, staffSeat, attemptId }`. The button
  needs to know all three before it can decide between "join and go", "go" and
  "you already took this one".
- `GET /evaluations/:id` therefore costs two more indexed single-row reads.
- `POST /evaluations/:id/release` reports the number of CLASS rows it froze,
  which is what it always meant.
- The deletion of an attempt has no typed live frame. Inventing one for a case
  only a teacher can cause would put a row deletion in the live path of a
  running exam; the dashboards watching the evaluation get a `hint` and
  re-read instead.
- `apps/web/src/help/evaluation.md` (and its French twin) describe the walk,
  mirroring the sibling project's wording.

## What this ADR does NOT decide

Nothing about a teacher taking an evaluation of a classroom they are NOT staff
of: they hold no seat, `reachableEvaluation` answers 404, and that stays.

Nothing about a second staff member seeing the first one's test attempt. They
do — it is a badged row like any other — and they cannot reset it. Whether a
course owner should be able to clear another teacher's rehearsal is a question
nobody has asked; `docs/spec/06-questions-ouvertes.md` is untouched.

Nothing about the existing "Student preview": it stays, it is cheaper, and it
answers a different question. The two are labelled so the difference is
readable ("Preview as student" vs "View as student").

## Rejected alternatives

1. **A dedicated "simulation" mode with its own attempt table.** A second
   write path for the student flow is a second place for the deadline, the
   milestone lock, the autosave revision race and the grading pass to differ
   from production. The whole value of the feature is that it is the SAME
   path.
2. **Hiding the staff attempt everywhere, as the results already did.** It is
   the least code and it makes the feature useless: the teacher tests a quiz
   and then cannot read what their test produced.
3. **Counting the staff attempt in the statistics and letting the teacher
   subtract.** A class of six with a teacher who knows the key is a mean that
   is wrong by a sixth, on the screen the teacher shows the class.
4. **Exporting the staff row with an `is_staff` column.** See decision 5: a
   marker only protects the readers who honour it, and a grade sheet outlives
   the conversation that explained the column.
5. **Making `POST /evaluations/:id/attempt` non-idempotent for a staff seat.**
   The idempotency is what makes two tabs share one seed and one deadline. It
   must not depend on who is asking; an explicit reset does the same job
   without touching the property.
6. **`PUT`-ing the attempt back to `not_started` instead of deleting it.** The
   answers, the journal and the gradings would survive, so the second walk
   would start half-filled and the "does the empty state look right?" question
   — one of the reasons to walk it — could never be asked again.
