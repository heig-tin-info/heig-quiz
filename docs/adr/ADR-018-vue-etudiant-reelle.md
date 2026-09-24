# ADR-018 — The real student view, and the teacher's own test attempt

## Status

Accepted (2026-09-22, asked for by the product owner). Amended twice the
same day by the two addenda at the end of this record: the first moves the
switch into the application frame and makes it per WINDOW, the second removes
the evaluation page's own button (and the read-only preview beside it) and
makes the heading rename itself. Decisions 1 and 2 below are the ones they
touch.

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


---

## Addendum (2026-09-22) — the switch belongs to the frame, and to the window

### Context

The walk above was reported back from its first real use, and it broke in two
places, both of them in decision 1 and decision 2.

**One entry point, on the wrong screen.** The teacher put themselves on the
roster, opened the lobby and launched the evaluation — from the LIVE
DASHBOARD, which is where a teacher is once a quiz is alive. "View as student"
is a button on the CONFIGURATION page. Having started the exam, they had no
way into it: the switch existed on a screen they had left, and the account
menu and the command palette — the two other entry points — were not where
anybody looked. They could start the test but not sit it.

**One store for every tab.** The view was held in `localStorage`, which the
whole browser shares. A teacher watching the grid in one tab and taking their
own attempt in another had both tabs in the same mode: opening the student
view in the second dragged the first out of the teacher UI. The two tabs are
the natural way to run this — the dashboard on the beamer, the attempt on the
laptop — and the store made it impossible.

### Decision

1. **The switch is part of the application frame, not of a page.** A
   `Teacher | Student` segmented control (`ViewModeToggle`, `Header.tsx`) sits
   in the bottom block of the sidebar, above the account row, and as one
   labelled icon in the phone top bar. It is drawn on every page the `Shell`
   draws — the live dashboard included — and in BOTH views, so the way out is
   exactly as reachable as the way in. It is SECONDARY chrome: no accent, the
   quiet pills of `Segmented`, one tier under the page's own primary action
   (invariant 2 is untouched — the toggle is not an action of any screen).

   A teacher and an admin get it; nobody else does. `onToggleStudentView` is
   `undefined` for a plain student, and the frame then draws no switch at all
   rather than one that would do nothing.

   The three older entry points stay and now delegate to the same store: the
   button on the evaluation page (which alone can also hand out a seat), the
   account menu, the command palette. What changed is that none of them is
   the only one.

2. **The student view is a property of the WINDOW.** The store moves from
   `localStorage` to `sessionStorage`, same two keys. It survives the reloads
   of its own tab — which the walk needs, the player being a page people
   reload — and reaches no other tab. The live dashboard therefore stays in
   the teacher UI in one tab while the other one sits the quiz.

   A key left behind in `localStorage` by the previous version is simply
   never read again: the teacher opens in the teacher view, which is the
   right default for a version that has just been deployed.

3. **Flipping to "student" lands on the current page's student twin.**
   `studentRouteFor` (in `studentView.ts`) maps the evaluation configuration
   and the live dashboard to that evaluation's own `/take/:id` — the route
   the SERVER routes, which answers the lobby before the start and the player
   after — leaves a page that is already a student page where it is, and
   sends everything else to the student home. A grading panel and a results
   table have no student twin that can be named without the reader's own
   attempt id, and guessing one would open another person's page. Flipping
   back returns to the page the walk started from, as before.

   The frame's switch does NOT hand out a seat: it has no classroom in hand
   on most pages, and a silent self-enrolment from a toggle is not something
   a teacher asked for. `/take/:id` answers `404` to a teacher with no seat,
   as it answers it to a stranger (invariant 6), and that refusal now has a
   screen of its own — "This evaluation is not available to you", with the
   way home, and, for a teacher only, the sentence that names the evaluation
   page's button as the thing that gives out the seat. Before, the route
   rendered a retry loop outside the Shell, with nothing on screen to leave
   by.

4. **The attempt route keeps no teacher chrome.** `/take/:id` renders outside
   the `Shell` — an exam is the one screen the rest of the app must go away
   from, and a teacher who sees more than a student does is not walking the
   student's quiz any more. So the frame's switch is not on it. The way out
   is the lobby's own "Leave", and, inside the player, one entry in the
   `Ctrl+K` palette ("Back to teacher view") that exists only when the switch
   is on — which, for a student, it never is. Nobody is stuck in either mode:
   every other page of the product carries the switch in its frame.

### Consequences

- `studentView.ts` gains `studentRouteFor` and owns `STUDENT_ROUTES`, which
  `App.tsx` used to hold. One list decides both what the student UI has a
  screen for and where the switch lands.
- `Player` gains an optional `onExitStudentView`, given only when the switch
  is on. Nothing else about the student flow changed.
- The screenshot scenes seed `sessionStorage` (`ss`) instead of
  `localStorage` for this key.
- A test that puts the app in the student view clears `sessionStorage`; the
  jsdom setup clears both before every test.

### Rejected alternatives

1. **Leaving the switch on the evaluation page and adding a second button to
   the live dashboard.** Two buttons, two screens, and the next screen a
   teacher is surprised on is a third. The view is a property of the window,
   so it belongs to the frame — the same argument that puts the theme toggle
   in the account menu rather than on every page.
2. **A primary button in the page header.** It would take the one accent of
   whatever screen it lands on, and the live dashboard's primary action is
   "Launch" — a switch that competes with it is a switch someone presses by
   mistake during an exam.
3. **Keeping `localStorage` and synchronising the tabs through the `storage`
   event.** That is the behaviour that was reported as the bug, made
   deliberate. The teacher wants the two tabs to DISAGREE.
4. **Mapping the grading panel and the results table to the teacher's own
   feedback page.** It needs an attempt id the frame does not have, and the
   one it could guess is somebody else's.
5. **Putting the switch on the exam screen too.** Then the teacher is not
   looking at what a student gets, which is the whole point of ADR-018, and
   the zen player grows chrome for a case that lasts one click.
6. **Self-enrolling from the frame's switch.** A toggle that writes a roster
   seat, from any page, with no confirmation, is a surprise. The evaluation
   page asks first, and keeps that job.

---

## Addendum (2026-09-22, second) — the page button goes, the frame switch stays

The product owner, looking at the evaluation header once the frame switch of
the previous addendum had shipped: the page now carried two ways into the
same walk, and the page one was the worse of the two — it exists on ONE
screen, and the teacher is on another by the time the quiz is alive.

1. **"View as student" is removed from the evaluation header.** Decision 1
   of the record above, and the sentence in the first addendum that kept the
   three older entry points, are superseded: the entry point is the
   `Teacher | Student` switch of the frame (`ViewModeToggle`), plus the
   account menu and the command palette, which are unchanged. With the button
   go its confirmation dialog, its `eval.viewAsStudent.*` strings and the
   page's only call to `POST /classrooms/:id/self-enroll`.

   The seat therefore comes from **"Join as student"** on the classroom page,
   which always gave it out and still does. The route is untouched on the
   server, and so is the staff-seat behaviour it carries. `player.noSeatHint`
   — the sentence a teacher gets from `/take/:id` without a seat — now names
   that button instead of the one that is gone.

2. **"Preview as student" is removed with it.** The read-only sheet
   (`PreviewSheet.tsx`) was the lesser half of a pair: it answered "are these
   the right questions?" only as long as something beside it answered "does
   this quiz work?". The real walk answers both. `POST /evaluations/:id/preview`
   STAYS on the server — it is a tested route with no client left, and the
   question-level preview page (`/questions/:id/preview`, a different feature)
   is untouched.

3. **Renaming happens on the title.** The "Rename" line of the overflow menu
   and the one-field modal behind it are replaced by `InlineTitle` (`ui/page.tsx`, formerly `ui.tsx`):
   the `<h1>` is a button that swaps itself for an input of the same size and
   weight, Enter or blur saves through the same `PATCH /evaluations/:id` and
   the same `EvaluationPatch` schema, Escape cancels, an empty title is
   refused and the old one restored. A pencil fades in on hover and on
   keyboard focus. It is not a primary action and takes no accent: the
   primary of each step stays what it is.

   It stays available on a frozen evaluation, because `title` is one of the
   server's `SAFE_FIELDS` — what freezes when a student starts is the
   structure, not the name.

After this, the header holds a breadcrumb, the editable title, the state
badge, the help "?" and the overflow menu (Live dashboard, Duplicate,
Delete, and Reset my test attempt when there is one) — plus "Grading" once
the evaluation is closed.

## Addendum (2026-09-24, third) — the way back from the attempt itself

The switch of the first addendum lives in the frame, and `/take/:id` is drawn
without one (`FULL_SCREEN`: an exam is where the rest of the app goes away).
A teacher walking their own quiz therefore had no way back but "Hand in",
which ends the very attempt they may want to resume. The student-view banner
of the frame (`StudentViewBanner`, `Shell.tsx`) is now also drawn by `App`
above the attempt, for a teacher in student view only: "Back to teacher view"
returns to the page the walk started from and leaves the attempt open. A
student never sees it.
