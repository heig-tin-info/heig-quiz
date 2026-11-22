# ADR-141 — Deleting what holds students' work is refused; the archive instead

## Status

Accepted (2026-11-21, product owner; recorded in the
[database remediation plan](../audits/2026-11-21-database-remediation.md)
§6.3). The exclusions (a staff seat, a poll), the lock and the shape of the
refusal are the implementer's, within that decision.

Scope: the deletion of a course, a classroom, an evaluation (exam or
exercise) and a project, by any route and any role.

Relations: amends [F-ORG-09](../spec/02-exigences-fonctionnelles.md),
[F-ORG-12](../spec/02-exigences-fonctionnelles.md) (an owner's deletion of
an evaluation holding a student attempt or released),
[F-PROJ-16](../spec/02-exigences-fonctionnelles.md) ("in any state") and
[N-DATA-03](../spec/03-exigences-non-fonctionnelles.md) (retention until
the teacher deletes); amends
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3, the row of
`DELETE /evaluations/:id`. Reads the staff seat of
[ADR-018](ADR-018-vue-etudiant-reelle.md) and the poll of
[ADR-014](ADR-014-sondages-en-direct.md); leaves account erasure to
[ADR-117](ADR-117-pseudonymisation-d-un-compte-sur-demande.md).

## Context

A course's deletion cascades in one statement through its classrooms,
evaluations, attempts, answers, gradings, gradebook marks, drill cards,
projects and their grades: 138 `ON DELETE CASCADE` foreign keys. The only
way back is a restore of the whole database, which loses every other
teacher's work since the dump (the remediation audit, finding F6). A
teacher who meant to tidy a list could erase a semester of graded work in
one click, and nothing short of a restore brings it back.

Classrooms and projects already have an archive, which takes them out of
the lists reversibly (F-ORG-03, F-PROJ-16). Evaluations and courses have
none: an evaluation leaves with its classroom's archive, and a course is
hidden per person (F-ORG-11), which is display state, not an archive.

## Decision

1. **Students' work** is a real student's. It is not a staff seat's
   attempt or repository (`enrollments.staff`, ADR-018: a teacher in the
   student view, the "self vs aggregates" rule; `isStaffAttempt` and
   `STUDENT_REPO` are the one definition of each), nor a poll's votes (a
   poll, `mode = 'poll'`, holds no grade; its guests are purged by
   ADR-014's own rule). An impersonation session writes nothing in
   production (ADR-034).

2. **An exam or an exercise** holds students' work once a student has an
   attempt that is started or submitted, a paper copy included
   (`started_at` or `submitted_at` set, or `origin = 'paper'`: the teacher
   enters a paper copy submitted, never started, ADR-125), once a student
   has a score in its gradebook column (point 4), or once it was released
   (`released_at`). A poll never does, and stays deletable under ADR-068's
   role rule. An exercise's attempts also feed its students' drill cards
   (ADR-041), which would go with it.

3. **A project** holds students' work once one of its student repositories
   is graded — a row of `project_repo_grades` (a teacher's score, an
   adjustment, a released snapshot), a **validated** row of
   `project_criterion_grades` (a proposal is not a grade), or any CI run of
   `project_grade_runs`, a failed one included (the safe side) — once a
   student has a score in its gradebook column (point 4), or once it was
   released (`released_at`). A draft has none of them and stays deletable;
   so does the row a failed build discards (`createProject`).

4. **The gradebook's scores.** A `score` mark (`gradebook_marks`, the
   teacher's own points, accepted before any release) on a real student's
   seat, in the column of an evaluation or a project, is a grade: it
   cascades with its activity, so it blocks the deletion. An `absent` or an
   `excused` mark is not a grade and blocks nothing (the coordinating
   implementer's call, 2026-11-22, within the owner's rule).

5. **A classroom** holds students' work when one of its evaluations or
   projects does; **a course** when one of its classrooms does. A course's
   templates hold no attempt and are never released: they never block, and
   they still go with their course.

6. **The refusal.** Deleting an entity that holds students' work answers
   **`409 holds_student_work`**, whatever the caller's role: neither an
   owner (ADR-068) nor an administrator with Super Powers (ADR-054)
   overrides it. The body is `StudentWorkRefusal` (`@quiz/contracts`):
   `work` counts what blocks by kind — classrooms, evaluations, projects,
   attempts holding work, graded repositories, gradebook scores, released
   activities — and never
   names a person. The pure rule is `studentWorkOf` (`@quiz/domain`). It
   comes before every other step of the delete: an evaluation's role check
   (an assistant learns the 409 an owner would get), and a classroom's
   journal confirmation (nobody types a name to learn the classroom stays).

7. **Under the lock.** The check runs again inside the delete's
   transaction, after the rows are locked, in this order:
   - the course and its classrooms `FOR UPDATE` (a new classroom,
     evaluation or project waits on its parent's `FOR KEY SHARE`; a mark
     waits too, `setMark` taking its classroom `FOR SHARE`);
   - the evaluations `FOR UPDATE` (a new attempt or paper copy, a new
     gradebook column, a release), then their attempts `FOR SHARE` (an
     attempt's start or hand-in, an UPDATE), then their gradebook columns
     `FOR UPDATE` (a new mark, whose foreign key takes `FOR KEY SHARE` on
     its column);
   - the projects and their repositories `FOR UPDATE` (a new repository, a
     grade, a run, a validation, a release), then their gradebook columns.

   An evaluation's or a project's own delete takes its row first, then the
   rest; a classroom `FOR SHARE` would not stop `setMark`, which takes the
   same share lock, so the columns are what close that window. Their
   existing marks are then locked `FOR SHARE`, all kinds: an absence or an
   excuse turned into a score (an upsert's `DO UPDATE`, which takes no lock
   on its column) waits for the delete too. Work that
   lands between a route's loader and its delete is either counted or waits
   for the delete and then finds its parent gone. `deleteEvaluation`'s
   existing lock (ADR-068 §3, amended 2026-10-10) is the model.

8. **The way out.** The web app says why in a dialog and offers the
   archive where the entity has one: a classroom's, a project's (its own
   confirmation follows, as it says what leaves the gradebook). An
   evaluation's Delete is greyed out with the reason (`holdsStudentWork` of
   `EvaluationSummary` and `EvaluationDetail`); a course's dialog sends to
   its classrooms' archive.

9. **No audit of the refusal.** None of the four modules audits a refused
   write today; the refusal changes nothing, and the audit union stays as
   it is (invariant 9).

The remediation audit's wording (§6.3) says "a submitted attempt". The
rule takes a **started or submitted** one, paper copies included: an
attempt is autosaved from its start, so an exam interrupted before hand-in
is a student's work too, and a paper copy is entered submitted without ever
being started.

## Consequences

- A semester's graded work can no longer be erased by a click. Tidying the
  lists is the archive's job; a deletion stays possible for a draft, a
  classroom that never held work, and a poll.
- **Retention.** N-DATA-03 kept a classroom's or an evaluation's data
  "until its deletion by the teacher". Students' work now has no deletion
  by the teacher: it is kept as long as the platform keeps it, until a
  retention rule of its own (issue #1027, the retention of attempts)
  decides an end. This is a conflict with N-DATA-03 as written, amended
  here, not resolved: the product owner's retention decision stays owed.
- The owner-only row of ADR-068 §3 for `DELETE /evaluations/:id` now
  covers only what no student work blocks: a correction published, a
  poll released, or an attempt row a student never started nor handed in.
- The cascades stay in the schema: a restore's cleanup and the retention
  purges still rely on them.

## Alternatives considered

- **A soft delete** (`deleted_at`). Every query, `staffAccess` and
  `readableClassroom` included, would need the filter; one forgotten
  filter shows a "deleted" course again, and invariant 6 would hang on it.
  Rejected by the product owner.
- **`ON DELETE RESTRICT` in the database.** It would refuse at the
  foreign key, but cannot tell a staff seat's attempt from a student's, a
  poll's votes from an exam's, or a proposal from a validated grade, and
  answers a constraint violation instead of a 409 that says what blocks.
- **The status quo**, a confirmation that names the entity. It already
  existed when the risk was found: a confirmation is read once and clicked
  through; it guards against a slip, not against a misunderstanding of
  what cascades.
