# ADR-131 — Components of the mean: a course's weighted shares of the gradebook's mean

## Status

Accepted (2026-11-16, product owner).

Scope: the components of the mean of a course (fr « composantes »), which
column of a classroom's gradebook counts toward a mean, the two-level mean,
what a student reads of them, the CSV, and who writes them; a column's
settings from the activity's draft on (§13); an evaluation template's
settings, which its instances inherit (§15). F-GBOOK-07 (new); F-GBOOK-01,
-02, -04, -05, -06, F-ORG-12, F-ORG-14, F-EVAL-14, -18, -24, -25, -26
amended.

Relations: amends [ADR-074](ADR-074-carnet-de-notes-marques-stockees.md) §6
(which columns count), §7 (the mean), §9 (what an archived gradebook's
read-only covers), its amendment of 2026-10-08 (the weights and the class
means, the CSV) and its amendment of 2026-10-13 (what the student reads
before the mean is published); amends
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 (three owner-only
routes); amends ADR-074 §6 (a column's settings exist from the draft on,
§13); amends [ADR-031](ADR-031-modeles-d-evaluation.md) §3 (what a template
holds: its gradebook settings too, outside its revision, §15). Depends on
ADR-068 §2 (reach, then role) and ADR-074 §8 (the gradebook reads, it never
grades); follows
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
    - **Hints.** A write to a column not listed yet (`columnFacts`'
      `listed`, false for a draft) tells the course's staff only: no
      student reads anything of it.
    - **Duplication** (F-EVAL-14). A copy carries its source's stored weight
      and counted flag, and its component when the copy's classroom is of
      the same course — another course has not got it; never the position,
      which orders the source's classroom. The `gradebook` module writes it
      (`copyColumnSettings`) as the column write itself, `patchColumn`, on
      the copy: a stored source makes a stored copy, even one holding its
      mode's defaults (so its flag survives a change of mode, as the
      source's), audited as the target classroom's
      `gradebook.column_updated` only when it differs from those defaults. A
      source with no stored row copies nothing; neither does a copy into an
      archived classroom, whose gradebook is read-only. The duplicate's
      route handler calls it — the evaluation's service, which the
      gradebook reaches through `activity`, does not import it — after the
      copy's own transaction: should it fail, the copy stands and reads its
      mode's defaults. A project has no duplication.
    - **No configuration lock.** These settings are the gradebook's, not
      the evaluation's: [ADR-079](ADR-079-conditions-de-l-evaluation.md)
      §4's `configLock` does not cover them, and they stay writable after
      the release.

14. **The screens** (`apps/web`; `DESIGN.md`, gradebook). The course's
    Settings tab holds the components (the owner writes, an assistant
    reads); it confirms the first component (§4), a re-weighting (§6) and a
    deletion. In the classroom's Grades tab a column's dialog has ONE
    control for where the column counts — each component, then "Out of the
    mean"; on a course without components "In the mean" or "Out of the
    mean" — beside its weight; a counted column in no component wears a
    warning, and a line above the table counts them; each component has its
    mean column before the overall mean. The student's tab draws one group
    per component, closed by its mean when the mean is published.
    **A change that moves a published mean is confirmed, not locked**
    (product owner, 2026-11-16): changing the weight, the component or the
    counted flag of a RELEASED column while the mean is published asks
    "Change the students' means?" first, on every course, with or without
    components; nothing else about the write changes.

15. **A template's settings** (product owner, 2026-11-16): an evaluation
    template ([ADR-031](ADR-031-modeles-d-evaluation.md)) carries a
    column's weight, counted flag and component, so that the evaluations a
    course makes from its templates each year arrive in the mean — without
    it, a course with components would see every new instance left out of
    every mean (§4) until someone filed it.
    - **Storage.** A `gradebook_columns` row with no classroom
      (`classroom_id` nullable since migration 0139;
      `gradebook_columns_home`: only an evaluation's row may lack one, a
      project having no template). The component's foreign key, `inUse` and
      `copyColumnSettings` hold unchanged: a component a template holds is
      **in use** (`409 component_in_use`). No reader lists the row: the
      tables read `storedColumns` by classroom, the student's rows join a
      column on their classroom's evaluations, and a mark's composite key
      carries a classroom that is never null, so no mark hangs on it.
      Deleting the template — or its course — takes it along (cascade).
      Known limit: a template deleted between its load and a settings write
      makes that write fail on the foreign key (a 500), as a draft's does.
    - **Which template.** `ActivityKind.columnFacts` takes a home, a
      classroom or a course: with a course, the evaluation kind answers a
      template of that course (a draft forever, so never `listed`), the
      project kind nothing.
    - **Routes**, in the `gradebook` module, the template loaded by
      `loadTemplate` (its course's `staffAccess`: anyone else gets the 404
      of a missing template), any member's (F-EVAL-25): `GET
      /app/api/templates/:id/gradebook` answers `GradebookColumnSettings` —
      the effective settings, the course's components, `released` and
      `meanPublished` false, which a template is: one payload for every
      settings screen, whose warnings stay quiet; `PATCH` takes
      `GradebookTemplateColumnPatch` — weight, counts, componentId, strict:
      no position, which orders a classroom's gradebook —, a component of
      the template's course or the 404 of a missing one, and answers the
      settings. The write is `patchColumn` itself with no classroom to lock:
      audited as `gradebook.column_updated`, subject the template
      (`evaluation`, beside its `template.*` entries); no hint, since a
      template has no topic (ADR-031) and no student reads it.
    - **Not the template's content.** These settings are the gradebook's: a
      write does not move the revision (ADR-031 §4), and a pull (F-EVAL-26),
      which replaces the questions only, never carries them. An instance's
      settings are its own from its instantiation; there is nothing to pull.
    - **Inheritance**, by `copyColumnSettings` exactly as a duplicate's
      (§13), called by the route handler after the copy's own transaction:
      *Instantiate* gives the new draft the template's stored settings
      (none in an archived classroom); *Save as template* gives the
      template the source's stored weight, flag and component (one course
      by construction); never a position; nothing stored, nothing carried.
      There is no copy of a template today; one into another course would
      carry the weight and the flag only, as a duplicate does.
    - **Mode change.** A template's stored flag survives its change of mode
      ([ADR-092](ADR-092-changer-le-mode-d-une-evaluation.md) §4); an
      untouched one reads its new mode's default.
    - **Promote stays open** (06 no. 25): nothing here pushes an instance's
      settings back into its template.

**Planned, not built** (the product owner's later parts): the activities'
settings rows over §13 and a template's over §15. Rules per component (a
pass mark per component) stay out.

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
- A template's settings (§15) are a row no reader lists, kept so by the
  readers' classroom filter alone; a component a template holds cannot be
  deleted, though no gradebook shows it. A change of a template's settings
  reaches next year's instances, never this year's.

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
- **A dedicated table for a template's settings** (`gradebook_template_columns`,
  keyed by the template). Declined (§15): `inUse`, the component deletion's
  check and `copyColumnSettings` would each read two tables, and the write a
  second audited path — while the nullable classroom costs one check and a
  scope whose classroom may be null, read in five places of the `gradebook`
  module (the home it resolves, the settings read's published mean, the
  write's lock and hint, its audit subject, the row's classroom) and once per
  activity kind (`columnFacts`' home), every reader already filtering by
  classroom.
- **A column's settings after publication only** (proposed by the spec
  challenger: a draft has no column, so nothing to set). Declined by the
  product owner (§13): the teacher decides the weight when building the
  activity, and should not have to come back after it is published — when
  changing it may already move what the students read.
