# 2. Data model and migration

Sources: classroom `C:db/schema.ts` (27 tables, one file, migrations up to
`0030_classroom-journal.sql`); Quiz `Q:db/*.ts` (split by module, migrations
0000–0026 at the time of writing).

## 2.1 What makes the migration tractable

1. **Every id is a random UUID on both sides** (`randomUUID()`). Classroom
   ids can be kept for every row **except users** (which merge). The
   exceptions: `audit_log` (bigserial, renumbered), `scheduled_tasks.key`
   (text), `webhook_deliveries.delivery_id` (GitHub's GUID).
2. **The identity tables are the same DDL.** Quiz's `users`,
   `user_emails`, `user_idp_claims`, `avatars`, `teacher_grants`,
   `audit_log`, `sessions` are copies of classroom's (`Q:db/auth.ts`).
   Classroom adds `users.github_user_id / github_login / github_linked_at /
   email_prefs`; Quiz adds `mcq_policy`, `coach_enabled`, `coach_seen`.
3. **The roster is the same concept.** `enrollments` is nearly identical;
   classroom has `status` (derivable: `user_id IS NULL` ⇔ pending), Quiz has
   `time_bonus_percent` and `note`. The claim rule at login is the same
   (`Q:modules/org/roster.ts`).

## 2.2 What makes it hard

1. **`oidc_sub` may differ between the two databases.** Both apps use
   edu-ID through **separate client registrations** (sharing a key and kid,
   `hgc-eduid-2026`). If edu-ID issues pairwise subjects, the same person
   has two subs. Classroom also ran a transitional Keycloak
   (`/kc/realms/hgc-dev`), so it may hold Keycloak-era subs and duplicates.
   **`swiss_edu_id` (`swissEduPersonUniqueID`) is the reliable key.**
   Measured by task M0-02 before anything relies on `sub`.
2. **"classroom" does not mean the same thing.** Classroom: the top-level
   unit, bound to one GitHub org, one owner (`teacher_id`), its own staff,
   no course, no period. Quiz: a period instance of a course; access comes
   from course staff (`staffAccess`, `Q:modules/guards.ts`), no owner. Each
   classroom-classroom is **merged into an existing Quiz classroom** named
   in a mapping file, or dropped (D22): the teachers create their Quiz
   classrooms, the import creates none.
3. **Staff is lossy.** `classroom_staff` invites by e-mail before the
   person has an account and labels teacher/assistant; Quiz's
   `course_staff(course_id, user_id)` requires an account and has no label
   (`unknown_account`, `Q:modules/org/routes.ts`). Access widens from one
   classroom to every classroom of the course; owner-only actions become
   staff actions. (Decision D04.)
4. **Grades are different objects.** Classroom: points/max as doubles from
   a CI annotation (forgeable by the student's code — classroom H5), final =
   teacher ?? LLM ?? frozen CI (`C:packages/domain/src/finalGrade.ts`), a
   max of 6 read as a Swiss mark. Quiz: `numeric(6,2)` points and a Swiss
   1–6 grade from `grading_scale`, frozen at release (`released_grades`).
   The ported tables keep their doubles; conversion happens in the gradebook
   (D05), never in the migration.
5. **Roles are computed differently.** Classroom: a grant, any staff
   e-mail (even pending), or any `staff` affiliation. Quiz: a grant, a
   course seat held by an account, or a staff affiliation within
   `STAFF_AFFILIATION_DOMAINS` (`Q:roles.ts`). Roles are **recomputed**
   after the import (`syncRoleOfUser(..., {succession: false})`), never
   copied; the differences are reported.
6. **The audit log is append-only in production** (no UPDATE/DELETE):
   imported rows cannot be fixed afterwards. Dry-run until the report is
   clean.

## 2.3 Table-by-table mapping

MAP = merge into an existing Quiz table; NEW = new Quiz table (owner
module); DROP.

### Identity and access

| Classroom | → Quiz | Rule |
| --- | --- | --- |
| `users` | `users` (MAP) | merged by identity (§2.4): only the people a MAPPED classroom reaches (roster, staff seats, owner), never those of a dropped one (D08 addendum); and, since M8-01b (2026-10-05, orchestrator), the student of a repository whose roster line is gone and the staff who graded or released a project: an account without seat keeps that repository and its grade history and gives no access (`readableClassroom` answers 404). A matched Quiz account keeps its `oidc_sub`, profile and settings untouched; a new one takes classroom's profile, `created_at` and settings, its classroom id where free, and the placeholder sub `classroom:<sub>` (ADR-061). GitHub columns → `github_accounts` through `importAccountLink` (`auth/githubLink.ts`, the table's one writer; spec 06 no. 45): same pair present, skipped; the Quiz user already linked to another GitHub id, or the GitHub id already another Quiz user's, reported and skipped; same id with another login, Quiz's login kept. `email_prefs` → `notification_preferences` rows (after the kinds exist, M3-09; reported until then) |
| `sessions` | DROP | everyone signs in again |
| `user_emails` | `user_emails` (MAP) | union per merged user; `first_seen_at` = min, `verified` = OR |
| `user_idp_claims`, `avatars` | MAP | claims: the row with the newer `updated_at`; avatars: a matched account keeps Quiz's (profile), a new one gets classroom's |
| `teacher_grants` | MAP | only the grants on a verified address of a person imported; union on `email`, `created_by` remapped, else the `--actor` running the import. `codespace_enabled`, `codespace_max_active_sessions` → NEW `codespace_grants` if M6 runs, else dropped and reported |
| `audit_log` | see D11 | suggested: NEW `legacy_classroom_audit_log`, read-only, users remapped best-effort; keeps the union closed |

### Organisation

| Classroom | → Quiz | Rule |
| --- | --- | --- |
| `organizations` | none (no. 46) | the import writes no `github_organizations` row: each teacher installs Quiz's App and connects their Quiz classrooms before the import (F-GH-02, D23), which is how Quiz learns the organization. The source org's `github_org_id` (or its login, when classroom never resolved the id) is only the check below |
| `classrooms` | none (D22) | **no classroom and no course is created.** The mapping file sends each classroom-classroom to an EXISTING Quiz classroom (course code + classroom name, resolved to ids in the report) or drops it. A mapped classroom must be connected (`github_classroom_links`) to the organization its source used, or the import refuses and names it; no `github_classroom_links` row is written. `teacher_id` → a `course_staff` seat |
| `classroom_staff` | `course_staff` (lossy) | claimed seats → seats of the mapped classroom's course; an `assistant` seat too, per open item 4 (`--assistants`, D04 (a): the widening is listed); pending seats reported |
| `enrollments` | `enrollments` (MAP) | `status` dropped after checking `status='claimed'` ⇔ `user_id IS NOT NULL` (refused otherwise); merged into the mapped Quiz roster on `lower(trim(email))`: a pending Quiz line is claimed by the imported account (`conflict_flag` when that account already holds a line, as a live claim does), a line claimed by another account is kept and reported, `time_bonus_percent` and `note` never written; a line missing from the Quiz roster per open item 3 (`--missing-students`) |

### Projects and GitHub (ids kept)

| Classroom | → Quiz (module `project` unless said) |
| --- | --- |
| `assignments` | `projects` (+ `classroom_id`, `org_id`, `grading_scale`; the codespace columns and `work_mode` dropped, D09) |
| `assignment_milestones` | `project_checkpoints` |
| `assignment_groups`, `assignment_group_members` | `project_groups`, `project_group_members` (`enrollment_id` through the enrollment remap) |
| `student_repos` | `project_repos` (`user_id`, `teacher_graded_by` remapped; the two partial uniques kept) |
| `grade_runs` | `project_grade_runs` (doubles kept as `points` / `max`, `kind` `llm` → `review`, `after_deadline`) |
| `push_receipts` | `push_receipts` (module `github`; `received_at` is the legal freeze reference) |
| `bot_commits`, `grade_dispatches`, `reverts` | same names, module `project` |
| `webhook_deliveries` | `webhook_deliveries` (module `github`), last 30 days only, none unprocessed at T0 |
| `scheduled_tasks` | rows DROPPED; the table is re-created by M2-05 (D10) and seeded by code |

### Journal

`journals` ⋈ `classroom_journals` → one `classroom_journals` row per
attached classroom (D03, `04-journal.md` §4.2), module `journal`; a journal
attached to several classrooms becomes several rows. Pages and assets are a
read model: not copied, re-ingested after the cutover through Quiz's App
(D23), which the organization must have installed. A classroom whose
teacher already chose the repository in Quiz before the cutover is left as
it is. Any other collision — a mapped classroom already linked in Quiz to a
different organization, or a journal on a different repository — is
reported by the dry run, which aborts; a person decides per classroom in
the mapping file (D22).

### Infrastructure

pg-boss: classroom's queues are drained at T0, not migrated. Queue names do
not collide (classroom: `webhook.process`, `deadline.apply`, `task.run`,
`sync.apply`, `grade.dispatch`, `email.send`, `journal.ingest`,
`codespace.sync`; Quiz: `grading.evaluation`, `grading.runner`,
`notifications.deliver`).

## 2.4 Identity matching

**Step 0 — measure (M0-02)**, read-only, on copies of both production
databases:

- among users with equal `swiss_edu_id`, the share with equal `oidc_sub`
  (does `sub` work as a cross-app key?);
- classroom users with a Keycloak-era `sub`, and the duplicates it causes;
- users without `swiss_edu_id` on each side;
- anonymised classroom users (`oidc_sub = anon-<id>`);
- pending staff seats, `work_mode` counts, group assignments, journals.

**Match cascade** (first unique hit on both sides wins):

1. equal `swiss_edu_id`;
2. equal `oidc_sub` — only if step 0 showed subs are shared;
3. a **verified** address held by exactly one account on each side,
   compared on `lower(trim())`;
4. otherwise a new Quiz user keeping its classroom id, with the placeholder
   sub `classroom:<sub>`.

Subs differ between the apps (M0-02: rule 2 never applies), so rule 4
needs **login adoption** in Quiz
([ADR-061](../adr/ADR-061-adoption-des-comptes-importes.md), task M1-06):
when a login `sub` is unknown, look for exactly one `classroom:`-prefixed
user with the same `swiss_edu_id`, or failing that holding an
institutional address of the login, or a private one unique on both sides;
rewrite its sub, audit it. Two or more: a new account and the ambiguity
audited.

**Never match** `dev:*` subs (a classroom `dev:` account is not imported
at all: its placeholder would be adoptable), `anon-*` users (imported as
new, still anonymised, without their addresses, claims or avatar),
unverified addresses. The rule is one pure function shared with login
adoption, `decideMatch` (`@quiz/domain`, ADR-061 §2); an address matches
only when it has exactly one verified holder on each side.

**Collisions to list in the dry-run**: two classroom accounts collapsing
into one Quiz user (breaks the unique constraints on enrollments,
individual `project_repos`, avatars, idp claims); an address held by two
accounts after the union (makes roster claims ambiguous).

## 2.5 The import script

`Q:apps/api/src/import-classroom.ts` (task M1-06 creates it, every
porting task that adds a table extends it, M8-01 completes it). Run with
`pnpm --filter @quiz/api import:classroom` in development; it is compiled
with the API, so the production image runs it as
`node dist/import-classroom.js` (from `/app`, nothing fetched). The target
is the environment's `DATABASE_URL`.

- **Inputs**: `--source-db <name>` (a database on the server of
  `DATABASE_URL`, reached with its credentials: the cutover restores
  classroom's dump there, so no password is ever on the command line; the
  session is opened `default_transaction_read_only=on` and the snapshot is
  read in one `REPEATABLE READ READ ONLY` transaction), `--mapping
  <file.json>` (required, zod `ClassroomMapping`: per classroom-classroom,
  by `id` and/or `name`, either `target: {course: <code>, classroom:
  <name>}` — an existing, connected Quiz classroom — or `drop: true`),
  `--actor <admin e-mail>` (recorded on the run and on a grant whose
  creator is not imported), `--dry-run` (default: one transaction, rolled
  back, full report) or `--apply`, and the open decisions
  `--assistants skip|staff` (item 4) and `--missing-students
  report|enroll` (item 3), whose defaults (`skip`, `report`) the product
  owner settled on 2026-10-05 (nothing is created, each is listed);
  `--final` (the cutover import: also enforces the source-state
  pre-flight), `--report-json <file>`, `--window-hours <n>`.
- **Re-import** (D26 addendum, 2026-10-05): a first import, then a final
  one. A row already imported is overwritten from classroom unless Quiz
  modified it since the previous import (a hash in `id_map`), in which case
  it is kept and listed; only rows the import created are overwritten.
- **Idempotency**: schema `import_classroom` (migration `0052`) with
  `id_map(source_table, source_id, target_id, how)` and `runs`; "insert
  unless it exists" everywhere else. A second `--apply` writes nothing: a
  run that changed nothing rolls back and records no run. The map also
  feeds the legacy URL resolver (M8-02); login adoption reads the
  `classroom:` placeholder sub, not the map.
- **Pre-flight** (refuses to `--apply` otherwise). M1-06: mapping
  complete and resolved (every source classroom, archived ones included,
  mapped or dropped; the target course code and classroom name each
  resolve to exactly one row), each mapped Quiz classroom connected to the
  organization its source classroom used, no ambiguous identity, the
  source consistent (enrollment status vs `user_id`), the actor an admin,
  the open decisions given. M8-01 adds: classroom stopped, its queues
  empty, no unprocessed webhook delivery, no assignment deadline + grace
  inside the window and none overdue unapplied, dangling grade-run links,
  group/assignment consistency.
- **Order** (foreign keys). M1-06: users map and new users → addresses,
  claims, avatars, GitHub account links → teacher grants → course staff
  (owners, claimed seats, assistants per item 4; pending ones reported) →
  enrollments (merged into the mapped rosters, remap recorded; missing
  lines per item 3) → role recompute → one `migration.classroom_import`
  audit row. M8-01 adds, before the role recompute: notification
  preferences, (codespace grants), projects, checkpoints, groups → group
  members → project repos → grade runs, push receipts, bot commits,
  dispatches, reverts → classroom journal rows (re-ingested after) →
  webhook deliveries (30 days) → legacy audit. No GitHub organization, no
  classroom↔org link, no course and no classroom is ever written (D22, spec
  06 no. 47).
- **Report**: the mapping with the resolved ids (for the teachers to
  check); refusals; the open decisions as given (or "suggested, NOT
  decided"); identity (already imported, matches per rule, created,
  ambiguous, not reached); rows written per table; findings per step
  (shared addresses, GitHub link conflicts, grants left behind, assistants
  widened, pending seats, roster lines added, flagged or kept, role
  changes, what later tasks carry). M8-01 adds the checks: repositories per
  project, `sum(teacher_points)`, count of frozen grades, every journal
  re-ingested with `sync_status = ok`, every grade-run link resolves,
  latest push receipt per repository equals the source.
- **Tests**: `apps/api/src/test/fixtures/classroom-seed.sql` (classroom's
  31 migrations concatenated, then synthetic, anonymised rows), imported
  into a PGlite Quiz database in `src/import-classroom.db.test.ts`; a
  second run writes nothing; a merge into an existing classroom; a
  duplicate identity refused; an unconnected or wrong-org classroom
  refused; a dropped classroom's people not imported; the GitHub link
  cases. Login adoption: `src/auth/adoption.db.test.ts`.

## 2.6 A class present in both databases

The Quiz classroom row wins; the roster is the union on lowercased e-mail;
staff is the union of the classroom owner, claimed seats and the existing
course staff; several classroom-classrooms may map to one course (typically
two semesters of the same course).
