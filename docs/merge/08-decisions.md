# 8. Decisions

The decisions that belong to the product owner. Each has a suggested answer;
none is taken until its **Status** says so. A task blocked by an open
decision says so in `PROGRESS.md`. When a decision is settled, write the
answer, the date and where it was settled (issue, PR, conversation), and
carry it into the spec or the ADR it belongs to (task M0-03 / M0-04).

Status values: `open`, `settled`, `superseded`.

## Blocking phase M1 (settle first)

### D01 — The name of the new activity kind
- **Suggested**: *Project* (FR *Projet*); "assignment" stays forbidden;
  covers a lab as well as a semester project.
- Blocks: M0-04 (glossary), every contract name.
- **Status**: settled 2026-09-28 (product owner, planning conversation): *Project*.

### D02 — Where a GitHub organization attaches
- **Options**: per classroom (as classroom does; one link table) or per
  course (inherited by its classrooms).
- **Suggested**: per classroom (`github_classroom_links`), the connect sheet
  proposing the org of the course's other classrooms. Migration is 1:1 and a
  course may legitimately change org between years.
- Blocks: M2-01.
- **Status**: settled 2026-09-28 (product owner, planning conversation): per classroom.

### D04 — Staff model
- **Questions**: (a) is widening from classroom staff to course staff
  acceptable (every staff of the course reaches every classroom, owner-only
  actions become staff actions)? (b) Quiz gains pending e-mail invitations
  of staff? (c) the assistant label?
- **Suggested**: (a) yes; (b) decide after M0-02 counts pending seats — if
  few, report and re-invite by hand; (c) dropped (display-only in
  classroom).
- Blocks: M1-06 (migration of staff), M0-04.
- **Status**: (a) settled 2026-09-28 (product owner, planning conversation):
  widening accepted. Noted risks, accepted: a teacher who has different
  assistants per class cannot keep them apart, and any staff of the course
  sees every classroom (risk of acting in the wrong one). A per-classroom
  restriction of staff is a possible later refinement, not part of the
  merge. (b) moot: M0-02 found 0 pending seats; (c) dropped as
  suggested.

### D08 — Identity key for the migration
- **Suggested**: the cascade `swiss_edu_id` → `sub` (only if shared) →
  verified e-mail → new user with `classroom:<sub>` + login adoption.
  Final shape after M0-02 measures the overlap.
- Blocks: M1-06.
- **Status**: settled by measurement 2026-09-28 (`measures-2026-09-28.md`):
  0 of 55 shared people have the same `sub` — edu-ID subjects are pairwise.
  Cascade `swiss_edu_id` → verified address → new user; **login adoption is
  required** (M1-06, with its ADR).

### D16 — Rename Quiz's "attempt journal"
- **Suggested**: yes, "attempt log" in docs and comments (not in table
  names), so "journal" means one thing.
- Blocks: M0-04.
- **Status**: settled 2026-09-28 (product owner, on the suggestion).
  Scope: `attempt_events` and the spec/ADR prose calling it the attempt's
  "journal" (e.g. spec 05 §5.5, ADR-018) become "attempt log"; the French UI
  strings that say "journal" for it (`eval.resetAttempt.message`,
  `eval.logVisibility.desc`) become "historique" or similar so that the
  word "Journal" in the student UI means only the course journal.

## Blocking later phases

### D03 — Where the journal lives
- **Options**: attached to a classroom, shareable between classrooms (as
  classroom); or attached to the course.
- **Suggested**: classroom attachment with sharing, as ported; the "Create
  a journal" sheet offers "use the journal of <previous classroom>" first.
- Blocks: M4-01.
- **Status**: open.

### D05 — Project grades
- **Questions**: are CI scores official? what do students see before the
  release? how does points/max map to 1–6 (classroom reads max = 6 as a
  mark)?
- **Suggested**: a project score reaches the gradebook only after a teacher
  **release**; before it, students see it marked "indicative"; a per-project
  `grading_scale` (Quiz's `Scale`), with "max 6 ⇒ the score is the grade" as
  one preset.
- Blocks: M3-01, M3-08.
- **Status**: open.

### D06 — Gradebook rules
- **Suggested**: exams and projects count by default, exercises opt-in,
  polls never; weighted mean rounded to the tenth; students see the mean
  only if the teacher publishes it; no ranking.
- Blocks: M5-03.
- **Status**: open.

### D07 — The student's door to the classroom page
- **Options**: (a) the classroom cards of the home always open the
  classroom page; (b) only when it has a journal or a project.
- **Suggested**: (a) — it is the target described by the product owner
  (activities, journal, grades); it is the one visible change before the
  cutover, shipped in M5.
- Blocks: M5-02.
- **Status**: open.

### D09 — Online workspace in the merge's critical path?
- **Question**: does production have assignments with `work_mode` ≠
  `free`? (M0-02 measures.)
- **Suggested**: if none, phase M6 runs after the cutover and the
  migration drops the codespace columns (reported); the portal is untouched
  meanwhile.
- Blocks: M6, M8-04.
- **Status**: measured 2026-09-28: 3 online assignments, all in test
  classrooms with a roster of 1. The suggestion applies (M6 after the
  cutover); awaiting the product owner's confirmation.

### D10 — Periodic tasks
- **Suggested**: port `scheduled_tasks` (restart-safe, admin-visible
  status, run-now); tasks seeded by code, period editable by admins.
- Blocks: M2-05.
- **Status**: open.

### D11 — Classroom's audit history
- **Suggested**: imported into a read-only `legacy_classroom_audit_log`
  table (actors remapped best-effort), so Quiz's union stays closed and
  clean.
- Blocks: M8-01.
- **Status**: open.

### D12 — Language of text written into GitHub
- (Seed READMEs, sync PR bodies, bot commit messages, revert commits.)
- **Suggested**: English — they are development artifacts read in a
  developer tool; UI strings stay translated.
- Blocks: M3-07.
- **Status**: open.

### D13 — Accommodations on project deadlines
- **Suggested**: the time bonus does not apply to projects; the per-repo
  manual unlock and a per-student deadline extension (later) cover the
  cases.
- Blocks: M3-05.
- **Status**: open.

### D14 — Journal asset storage
- **Suggested**: `bytea` as ported (a rebuildable read model, ≤ 5 MB per
  asset); revisit if the backup grows noticeably.
- Blocks: M4-01.
- **Status**: open.

### D15 — HTML in the journal
- **Suggested**: keep the journal's rule (raw HTML escaped to text) and
  Quiz's rule for questions (sanitised allow-list), each on its surface.
- Blocks: M4-01.
- **Status**: open.

### D17 — LLM grading
- **Suggested**: the merge ports classroom's CI-dispatched LLM review as
  is; a platform `llm` module is phase L.
- Blocks: nothing on the critical path.
- **Status**: open.

### D18 — Notification kinds for projects
- **Suggested**: student `project_published`, `project_deadline_reminder`,
  `project_repo_invited`, `project_grade_final`; staff
  `project_deadline_applied`, `project_provision_failed`,
  `github_org_lost`; e-mail on by default only for must-not-miss kinds
  (ADR-030 defaults); `activity_*` payloads kind-neutral.
- Blocks: M3-09.
- **Status**: open.

### D19 — Deletion of a classroom or project
- **Suggested**: deletes database rows only; GitHub repositories are never
  deleted (classroom H11), and the confirmation says so.
- Blocks: M3-02.
- **Status**: open.

### D20 — The cutover window
- **Suggested**: the intersemester (February 2027), a weekday morning with
  no deadline and no evaluation; announced a week and a day ahead.
- Blocks: M8-07.
- **Status**: open.

### D21 — Unified SEB design
- **Suggested**: `packages/seb`; the platform builds every `.seb`; a `seb`
  session confined to an activity; BEKs optional per activity (Config Key
  only by default); proof B before the first SEB project (§6.3).
- Blocks: M6-02, M6-07.
- **Status**: open.

### D22 — The classroom-to-course mapping
- **Question**: for each classroom-classroom in production, which Quiz
  course (existing or new) and whether it merges into an existing Quiz
  classroom.
- **Suggested**: the product owner writes the mapping file from the list
  produced by M0-02.
- Blocks: M8-06.
- **Status**: open.
