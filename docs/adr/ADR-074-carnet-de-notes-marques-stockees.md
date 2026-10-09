# ADR-074 — Gradebook: stored marks beside derived absence

## Status

Accepted (2026-10-05; the rules of D06 settled on 2026-10-01 by the product
owner, the stored marks, the two sources of an absence and the override rule
on 2026-10-05 by the product owner and the orchestrator of the merge).
Implemented by merge task M5-03a (`apps/api/src/modules/gradebook/`, domain
rules in `packages/domain/src/gradebook.ts`, migration `0075_gradebook`); the
CSV export is M5-03b and the screens M5-04.

Scope: F-GBOOK-01..06 (F-GBOOK-01 amended the same day), the `gradebook`
module, and the gradebook entries of the `ActivityKind` registry.

Amended 2026-10-08 (product owner, #545): the unit of a column's weight
(§6, §7) and the class means; see *Amendment of 2026-10-08* at the end of
the Decision.

Relations: completes D06 (`docs/merge/08-decisions.md`) and spec 06 no. 48
(`docs/spec/history/settled-questions.md`, "how a teacher marks an absence by
hand", settled here); reads the releases of
[ADR-012](ADR-012-gel-note-deux-temps.md) (evaluations: `released_grades`;
projects: the frozen score and its release, F-PROJ-14) without changing
them; the student exit follows F-RES-04 and spec 05 §5.7.

Amended 2026-10-09: the consequence on the student's global Grades page records M5-04's decision instead of deferring to it.

## Context

D06 made the gradebook one table per classroom: a column per evaluation or
project, a weight per column, a mean to the tenth, no ranking, the mean shown
to students only if the teacher publishes it. Two gaps remained.

1. The school's grade tool writes `a1.0` for an absent student: 1.0, counted,
   marked as an absence. Quiz already gives a student who never took a
   released evaluation the scale minimum (F-RES-02), but nothing says that
   cell is an absence, and a teacher has no way to mark one by hand (an
   exercise nobody opened is not an absence; a student excused from an exam
   is not either).
2. A student who never accepted a project has no repository, so no row holds
   a score for them. M3-01 deferred it: "never accepted: an empty cell that
   does not count, until a teacher sets a score" (F-GBOOK-01, no. 48).

## Decision

1. **A cell is a grade, an absence or empty.** An absence is 1.0 shown with a
   sigil and a colour of its own (never colour alone, N-A11Y-03), which
   counts as 1.0 in the mean. An empty cell has no grade and is left out of
   the mean. The rules are pure, in `@quiz/domain` (`gradebook.ts`).

2. **Two sources of an absence, both shown with the sigil.**
   - *Derived, computed, never stored*: a **released exam** the student did
     not take (no attempt, or none handed in). A released **exercise** not
     taken is an **empty** cell, not an absence.
   - *Stored*: a staff **mark** `absent`.

3. **Stored marks** (`gradebook_marks`: classroom, column, roster line, `kind`
   `absent` | `score`, points and maximum for a score, an optional staff-only
   comment, who and when; unique per column and student). Staff only, on a
   claimed student seat. A `score` converts with the activity's own scale (an
   evaluation's, a project's): it is also **the teacher's score for a student
   who never accepted a project**, which fills the gap of M3-01. Leaving the
   roster deletes the student's marks with their line.

4. **A mark wins over anything beneath it.** A teacher may replace a real
   grade (a regrade by hand, an excused absence), but deliberately: putting a
   mark where a real grade lies is `409 grade_exists` unless the request says
   `override: true`; replacing a mark already there needs no new override;
   clearing one is explicit (`DELETE`) and gives the cell back to the
   activity. Every set and clear is audited with its **before and after**
   (`gradebook.mark_set`, `gradebook.mark_cleared`).

5. **Marks reach a student only once the column is released** (the evaluation
   released, the project released) and, for an evaluation, only where the
   feedback policy does not withhold its grade: under the policy `none` the
   student reads no grade, a mark included. Before the release, a mark is
   staff-only and out of the mean. A student never reads a mark's comment or
   points, nor any source.

6. **Columns.** A column exists per exam, exercise and graded project that is
   no draft; a poll never has one. Exams and projects **count** by default,
   exercises are **opt-in**, per column (the `counts` flag: the teacher
   includes the exercises they choose, not all of them at once). A column's
   **weight** is 0 to 10 at the tenth, 1 by default (*amended 2026-10-08:
   a whole percentage 0 to 100, 100 % by default, below*). A stored column row
   (`gradebook_columns`, exactly one of `evaluation_id` / `project_id`) is
   made by the first write that names it; an activity without one has the
   defaults. `position` lets the teacher order columns; the default order is
   the activity's date.

7. **The mean** is the weighted mean of the **released** columns that count
   and in which the student has a grade (an absence is a 1.0), computed from
   the **displayed, tenth-rounded cell grades** in integer tenths (so a half
   tenth rounds up exactly), rounded to the tenth. No ranking. It is shown to
   students only if the teacher **publishes it** (`gradebook_settings`, off by
   default): until then the key is absent from the student's JSON, not null.
   A student's mean is computed from what they are shown: a grade withheld or
   merely indicative is not in it.

8. **The gradebook reads, it never grades.** The activity kinds answer through
   `ActivityKind.gradebookEntries` and `studentGradebookEntries`: an
   evaluation's cells are the results (`resultsView`, a student's the rows of
   their Grades page, `studentGrades`, under F-RES-04); a project's the live
   final score of the staff's page (`repoScores` through `releasableScore`,
   graded by `scoreGrade`, with its source and whether it changed after the
   release), a student's the release's snapshot. `gradebook` imports neither
   `results` nor `project`. A column follows its activity (F-GBOOK-03).

9. **Access.** The staff table loads the classroom through `staffAccess` (404
   for anyone else); the student's cells through `readableClassroom` with the
   student payload forced (a teacher in the student view and an impersonation
   get the student shape, empty for a staff seat; a `seb` or `kiosk` session
   gets nothing). Settings and marks are open to every member of the staff,
   an assistant included (ADR-068: a classroom's settings), with one
   exception (orchestrator, 2026-10-05, following the owner-only release and
   correction publication of ADR-068 §3): publishing, **changing or clearing a mark over a real grade on a
   released column** (a published correction; `override: true`) is an
   **owner's** act, `403 owner_required` for an assistant. Marks on a column not released, and an
   absence over an empty cell, stay open to every member; what makes a grade
   final stays the activity's own release. An **archived** classroom's
   gradebook is read-only (`409 classroom_archived`). The settings are audited
   (`gradebook.column_updated`, `gradebook.mean_published`,
   `gradebook.mean_unpublished`).

### Amendment of 2026-10-08 (product owner, #545)

Scope: the weight of §6 and the mean of §7; the staff's table and its CSV
gain the class means. Everything else stands.

1. **A weight is a whole percentage, 0 to 100, 100 % by default**
   (`gradebook_columns.weight` `integer`, check 0..100, default 100;
   `GradebookWeight` in `@quiz/contracts` on both sides). It is read
   more easily than a coefficient, and it is shown in the column's header
   ("Exam · 40 %").
2. **Weights are relative, not a budget.** They need not sum to 100: a
   student's mean is Σ(wᵢ·gᵢ) / Σ(wᵢ) over the released columns that count
   and in which they have a grade, as §7 says, in integers (percent ×
   tenths) so the half tenth still rounds up exactly. Ten quizzes at 10 %
   and an exam at 100 % make the exam half of the mean. A column with no
   grade for the student is skipped and the others renormalised (F-GBOOK-02
   as written, not a 0); 0 % keeps the column in view and out of the mean;
   all weights at 0 % give no mean.
3. **Class means, staff only.** A released column's class mean is the plain
   mean of the grades its cells count as — an absence (derived or marked)
   as 1.0, exactly as a student's mean counts it; an empty cell left out —,
   null before the release. The class's overall mean is the plain mean of
   the students' means, a student without one left out. Both are computed
   on read (`classMean`, `@quiz/domain`), never stored, never in a student
   payload. The CSV gains a `weight` line under its header and a last
   `class_mean` line (F-GBOOK-04).
4. **The student's view is unchanged**: the mean only when published, and
   with it each column's weight (now in percent) and counted flag, as §7
   and F-GBOOK-05 had it.
5. **Migration** (`0089_gradebook_weight_percent`). A coefficient 2 next to
   1s meant double weight; ×100 would give 200, outside the new range. So
   each classroom is **normalised to its largest weight**: the weights are
   taken in tenths (exact), divided by the classroom's largest — never less
   than the old default 1 — and multiplied by 100, rounded to the whole
   percent. A classroom whose weights never exceeded 1 is thus ×100 exactly;
   one with a 2 beside 1s becomes 100 % beside 50 %. In such a classroom an
   activity without a stored column weighed the old default 1, which the
   new default would turn into 100 %: the migration stores those columns
   (the activities of `gradebookEntries`: exams and exercises that are no
   draft, graded projects that are no draft, with their kind's `counts`) at
   1 first, so the normalisation reaches them. Relative weights are kept
   within each classroom; only rounding to the whole percent can move a
   mean, slightly. In a classroom normalised from a largest weight above 1,
   an activity created later (or still a draft at migration time) gets the
   new default 100 %, that is the classroom's top weight, not the old
   default's normalised share. (Production held no stored column on the
   day.)
6. The weight change stays audited as `gradebook.column_updated`, its
   before and after now in percent. Duplicating a classroom copies no
   gradebook column (none did before), so no weight either.

## Consequences

- A teacher can express "absent", "excused" and "graded by hand" without
  editing the activity, and the audit says who changed what.
- The student exit is one more place where unreleased values must never
  appear: a test searches every student response (student, teacher in the
  student view, impersonation) for an unreleased grade, a mark's comment and
  another student's data.
- Two stored kinds of column settings: a column nobody touched has no row.
- The student's global Grades page (`/grades`) keeps its own rows
  (`StudentGrades`, `GET /app/api/student/results`): M5-04 decided not to
  move it onto the gradebook, whose cells carry no status, feedback link nor
  pending count (D06 note of 2026-10-01; card M5-04, "As delivered").

## Alternatives considered

- **Store the derived absence as a row at release.** Rejected: a row per
  student per exam would go stale when a student is excused, a retake lands
  or a regrade changes who took the exam; a computed cell cannot disagree
  with the results.
- **A classroom-wide switch for counting exercises.** Rejected: a teacher
  counts the exercises they grade, not all of them; the per-column flag
  carries the same default with finer control.
- **Mark only on empty cells.** Rejected: an excused absence or a regrade
  replaces a real grade; the explicit `override` keeps that deliberate.
- **Show the mean to students whenever one exists.** Rejected by D06: the
  teacher publishes it, off by default.
