# ADR-131 — Components of the mean: a course's weighted shares of the gradebook's mean

## Status

Accepted (2026-11-16, product owner).

Scope: the components of the mean of a course (fr « composantes »), which
column of a classroom's gradebook counts toward a mean, the two-level mean,
what a student reads of them, the CSV, and who writes them; a column's
settings from the activity's draft on (§13). F-GBOOK-07 (new); F-GBOOK-01,
-02, -04, -05, -06, F-ORG-12, F-ORG-14, F-EVAL-14 amended.

Relations: amends [ADR-074](ADR-074-carnet-de-notes-marques-stockees.md) §6
(which columns count), §7 (the mean), §9 (what an archived gradebook's
read-only covers), its amendment of 2026-10-08 (the weights and the class
means, the CSV) and its amendment of 2026-10-13 (what the student reads
before the mean is published); amends
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 (three owner-only
routes); amends ADR-074 §6 (a column's settings exist from the draft on,
§13). Depends on ADR-068 §2 (reach, then role) and ADR-074 §8 (the
gradebook reads, it never grades); follows
[ADR-092](ADR-092-changer-le-mode-d-une-evaluation.md) §4 (a stored flag
across a change of mode).

## Context

A course's grade is often not one weighted mean of its activities but a mean
of parts: "the labs count 50 %, the tests 50 %", each part averaging its own
activities with their own weights. The school's rules state it that way, and
a teacher computed it by hand beside Quiz's gradebook, whose mean (ADR-074
§7, the amendment of 2026-10-08) is one weighted mean over every counted
column. Weighting columns alone cannot express it: the share of the labs
would move with the number of labs a student has a grade in.

The product owner's example: labs L1 at 10 % and L2 at 100 % in "Labo" at
50 %; tests TE1 and TE2 at 100 % each in "Cours" at 50 %; the mean is
0.5 · (0.1 · L1 + 1.0 · L2) / 1.1 + 0.5 · (TE1 + TE2) / 2.

The word "group" was set aside: Groups already names the students' groups
(ADR-070). The UI word is **component** (fr « composante »).

## Decision

1. **Components live on the course** (`gradebook_components`, owned by the
   `gradebook` module): a name — trimmed, 1 to 40 characters, unique in the
   course whatever its case — and a weight, a whole percentage 0 to 100,
   **relative** like a column's (they need not sum to 100), 100 % by default.
   Their order is their creation order (creation time, then id): no
   position, no reorder, no archive.

2. **A column may be in one component** (`gradebook_columns.component_id`,
   null for none), a component of its classroom's course: the service
   refuses another course's with the 404 of a missing component. The
   foreign key is the default NO ACTION, checked at the end of the
   statement, so deleting a course — which cascades to both tables — passes,
   while deleting a component a column is still in does not.

3. **The two-level mean** (`gradebookMeans`, `@quiz/domain`). With no
   component on the course, everything is ADR-074's. With at least one, a
   component's mean is ADR-074's formula — Σ(wᵢ·gᵢ)/Σ(wᵢ) over ITS released,
   counted columns the student has a grade in, from the displayed tenths —
   **rounded to the tenth** (half up, in integers); the overall mean is the
   same formula over the components' rounded means, weighted by the
   components' weights, rounded to the tenth. A component with no mean for
   the student (no grade, all excused, no column) is skipped and the others
   renormalised; a component at 0 % keeps its own mean in view and is out of
   the overall one; all at 0 % give no mean. A course without a component
   is the same computation over one implicit component holding every
   column, whose rounded mean is the one-level mean exactly: one code path.

4. **Course-wide activation.** As soon as the course has one component, a
   counted column in no component counts in **no** mean, in every classroom
   of the course, archived ones included. One pure predicate,
   `countsInMean(counts, componentId, courseHasComponents)`, is THE rule of
   "this column counts": the mean reads it, and so do the student's
   effective `counts` flag of the classroom's Grades tab (still false for an
   excused cell, ADR-074 amendment of 2026-10-29) and the rows of the
   student's Grades page (`EvaluationGradeRow.counts`,
   `ProjectGradeRow.counts`), which must keep agreeing.
   The staff's `counts` stays the stored flag; the warning "counted, in no
   component" is the screen's, derived with the same predicate.

5. **Who writes.** Creating, renaming, re-weighting and deleting a
   component are the course **owner's** (`403 owner_required` for an
   assistant, decided in the loader before the body, ADR-068 §2): they
   change every classroom's means. Reading the list is every member's.
   Putting a column in a component is any member's, like the column's other
   settings (`GradebookColumnPatch.componentId`, audited in
   `gradebook.column_updated`'s before and after). A component is deleted
   only while no column of any classroom is in it (`409 component_in_use`);
   a name taken is `409 component_name_taken`. Audited, subject the course:
   `gradebook.component_created`, `gradebook.component_updated` (before and
   after), `gradebook.component_deleted`. Routes, in the `gradebook` module,
   loaded through the course's `staffAccess` (anyone else: the 404 of a
   missing course): `GET`, `POST /app/api/courses/:id/gradebook/components`,
   `PATCH`, `DELETE …/components/:componentId`; each write answers the list,
   each item with `inUse`.

6. **Live, no freeze.** A component's weight and name are read live by every
   table of the course: re-weighting moves the means of archived classrooms
   too, accepted (the web confirms it). An archived classroom's gradebook
   stays read-only for its OWN writes — marks, column settings, the
   published mean (ADR-074 §9) — so its columns cannot move to another
   component there; the course's components, which are not the classroom's,
   still apply to it.

7. **The student's exit** (invariant 4, spec 05 §5.7). A student always
   reads the **name** of the component of each of their columns that counts
   (`GradebookStudentColumn.componentId`, and the component in
   `GradebookStudent.components`): it is structure, like the `counts` flag —
   how they are graded. The list holds only the components that hold one of
   the student's own counting columns. A component's **weight** and the
   student's own **means** of the components ride with the overall mean:
   only when the teacher publishes it, the keys absent otherwise. A
   component's class mean is the staff's alone. Tested by searching every
   student response — the student, a teacher in the student view, an
   impersonation and the personal export — for weights and means while the
   mean is unpublished.

8. **The staff's table.** `GradebookStaff.components`: every component of the
   course in order, with `classMean`, the plain mean of the students' means
   of it (a student with none left out); each column's `componentId`; each
   row's `componentMeans` by component id beside `mean`.

9. **The CSV** (F-GBOOK-04). With components: one column per component,
   named after it, just before `mean` (still last), holding each student's
   mean of it; a `component` line right under the header naming each
   column's component (the label in the e-mail field, as `weight`); the
   `weight` line carries the components' weights under their columns (and
   no weight for a counted column in no component, which counts nowhere);
   `class_mean` their class means. Without a component the file is byte for
   byte what it was.

10. **Hints.** A component's write tells the course's staff and every
    claimed student of every classroom of the course (`gradebookChanged`),
    never a `classroom:` topic; a column's settings now tell the classroom's
    students always, since its flag, its component and its place are theirs
    to read.

11. **The Grades page** (`/grades`, F-ORG-14): each row gains `component`, the
    name of the component it counts in, null when it does not count or the
    course has none — a caption. No mean there.

12. **The teacher assistant** (ADR-080): the results reader's fixed text says
    how the two-level mean is computed, and its result carries the
    components, each column's component and each student's means of them.

13. **A column's settings from the draft on** (product owner, 2026-11-16):
    a teacher sets an activity's weight, whether it counts and its
    component while creating it, in its settings, so the weight is not
    changed after publication.
    - **Which activity.** Each kind answers one rule,
      `ActivityKind.columnFacts`: any exam or exercise of the classroom
      whatever its state, never a poll; any graded project of the classroom
      not archived, whatever its state — `gradebookEntries`' rule without
      its draft exclusion. `PATCH …/gradebook/columns/:kind/:activityId`
      resolves through it (the rest of the write unchanged: archived
      classroom `409`, component of the course or `404`, audited, hints) and
      so does a new staff read, `GET` on the same address
      (`GradebookColumnSettings`): the effective `weight`, `counts`,
      `componentId` — stored or the mode's defaults —, the course's
      components (id, name, weight), `released` (false for a draft) and
      `meanPublished`, what a settings screen needs to warn that a change
      moves what the students read. The marks keep `gradebookEntries`: a
      mark on a draft is a 404.
    - **Inert until published.** The draft's row is materialized by the
      first write, as any column's. Every reader — the staff's table, the
      CSV, the student's cells, the Grades page, the mean, the assistant —
      goes through `gradebookEntries` / `studentGradebookEntries`, which
      list no draft, so the row reaches nobody until the activity leaves
      the draft; then its column appears with the stored settings. It holds
      its component **in use** (`409 component_in_use` on a deletion), and
      deleting the draft takes it along (the foreign key's cascade).
    - **Mode change.** A draft's stored `counts` is kept when the
      evaluation's mode changes, as
      [ADR-092](ADR-092-changer-le-mode-d-une-evaluation.md) §4 keeps any
      stored column's; a draft nobody touched reads its new mode's default.
    - **Duplication** (F-EVAL-14). A copy carries its source's stored weight
      and counted flag, and its component when the copy's classroom is of
      the same course — another course has not got it; never the position,
      which orders the source's classroom. A source with no stored row
      copies nothing; neither does a copy into an archived classroom, whose
      gradebook is read-only. The `gradebook` module writes it
      (`copyColumnSettings`), called by the duplicate's route handler — the
      evaluation's service, which the gradebook reaches through `activity`,
      does not import it — and audits it as the target classroom's
      `gradebook.column_updated`, `before` the mode's defaults. A project
      has no duplication.
    - **No configuration lock.** These settings are the gradebook's, not
      the evaluation's: [ADR-079](ADR-079-conditions-de-l-evaluation.md)
      §4's `configLock` does not cover them, and they stay writable after
      the release.

**Planned, not built** (the product owner's later parts): the screens (the
course's Settings section, the gradebook's, the activities' settings rows
over §13), and templates carrying a column's weight, counted flag and
component. Rules per component (a pass mark per component) stay out.

## Consequences

- A teacher states the school's rule once per course, and every classroom of
  it, past and present, reads the same structure.
- Turning components on is a one-way change for the counted columns left
  outside: they leave every mean at once, archived classrooms included,
  whose columns cannot be reassigned.
- Re-weighting a component silently moves archived classrooms' means; no
  snapshot keeps an old mean.
- One more stored setting a student reads before the mean is published: the
  component's name. Its weight and the means stay withheld, as ADR-074's
  column weight.
- Each reader of the mean (staff table, student's tab, Grades page, CSV,
  assistant) goes through `countsInMean` and `gradebookMeans`; a new reader
  must too.
- A draft's settings (§13) are stored where no reader looks until it leaves
  the draft: a reader that listed columns without `gradebookEntries` would
  read them early. A component a draft's column is in cannot be deleted,
  though no table shows that column yet.

## Alternatives considered

- **Per-classroom activation** (proposed by the spec challenger): components
  apply to a classroom only once one of its columns joins one, so an
  archived classroom keeps its one-level mean. Declined by the product
  owner: a course's rule is one rule; a classroom half on, half off would
  compute two different means for the same course.
- **A position, a reorder and an archive of components.** Rejected as YAGNI:
  a course holds two or three, created in the order they are read; each can
  be added later without a migration of meaning.
- **Exact, unrounded component means** in the overall mean. Rejected: the
  student and the school read each component's mean to the tenth, and the
  overall mean must be computable from what they read, as ADR-074 §7
  computes the mean from the displayed cells.
- **Freezing the components at a classroom's archive.** Rejected: it would
  copy the components per classroom for a case the product owner judged
  rare; the live reading is stated instead.
- **"Group" as the name.** Rejected: Groups are the students' (ADR-070).
- **A column's settings after publication only** (proposed by the spec
  challenger: a draft has no column, so nothing to set). Declined by the
  product owner (§13): the teacher decides the weight when building the
  activity, and should not have to come back after it is published — when
  changing it may already move what the students read.
