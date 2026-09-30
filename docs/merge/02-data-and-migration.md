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
   classroom-classroom becomes a Quiz classroom **under a course chosen in a
   mapping file** (new course, or an existing one, or merged into an
   existing Quiz classroom of the same class).
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
| `users` | `users` (MAP) | merged by identity (§2.4). GitHub columns → NEW `github_accounts(user_id PK, github_user_id UNIQUE, login, linked_at)` (module `auth`, beside `users`: written by `auth/githubLink.ts` only, M2-03). `email_prefs` → `notification_preferences` rows (after the kinds exist, M3-09). Profile fields from the side with the newer `last_login_at`; earliest `created_at`; Quiz's `locale`, `date_format`, MCQ and coach settings win |
| `sessions` | DROP | everyone signs in again |
| `user_emails` | `user_emails` (MAP) | union per merged user; `first_seen_at` = min, `verified` = OR |
| `user_idp_claims`, `avatars` | MAP | keep the row with the newer `updated_at` |
| `teacher_grants` | MAP | union on `email`, `created_by` remapped. `codespace_enabled`, `codespace_max_active_sessions` → NEW `codespace_grants` if M6 runs, else dropped and reported |
| `audit_log` | see D11 | suggested: NEW `legacy_classroom_audit_log`, read-only, users remapped best-effort; keeps the union closed |

### Organisation

| Classroom | → Quiz | Rule |
| --- | --- | --- |
| `organizations` | NEW `github_organizations` | `github_org_id`, `login`, status, plan kept; `installation_id` is Quiz's App's (D23), resolved when the organization installs it, null until then |
| `classrooms` | `classrooms` (MAP) | + `course_id` from the mapping file; `period` empty (the CHECK allows no start/end); `org_id` → NEW `github_classroom_links(classroom_id PK, org_id, linked_by, linked_at)`; `teacher_id` → a `course_staff` seat; `archived_at` kept |
| `classroom_staff` | `course_staff` (lossy) | claimed seats → seats of the course; pending seats and the `assistant` label reported (D04) |
| `enrollments` | `enrollments` (MAP) | `status` dropped after checking `status='claimed'` ⇔ `user_id IS NOT NULL`; when merging into an existing Quiz classroom: union on `lower(trim(email))`, conflicting users flagged with `conflict_flag` as a live claim does |

### Projects and GitHub (ids kept)

| Classroom | → Quiz (module `project` unless said) |
| --- | --- |
| `assignments` | `projects` (+ `classroom_id`, `grading_scale`; codespace columns only if M6) |
| `assignment_milestones` | `project_milestones` |
| `assignment_groups`, `assignment_group_members` | `project_groups`, `project_group_members` (`enrollment_id` through the enrollment remap) |
| `student_repos` | `project_repos` (`user_id`, `teacher_graded_by` remapped; the two partial uniques kept) |
| `grade_runs` | `project_grade_runs` (doubles kept, `kind` ci/llm, `after_deadline`) |
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

If subs differ between the apps, rule 4 needs **login adoption** in Quiz
(an ADR, task M1-06): when a login `sub` is unknown, look for exactly one
`classroom:`-prefixed user with the same `swiss_edu_id` (or failing that the
same verified address), rewrite its sub, audit it.

**Never match** `dev:*` subs, `anon-*` users (imported as new, still
anonymised), unverified addresses.

**Collisions to list in the dry-run**: two classroom accounts collapsing
into one Quiz user (breaks the unique constraints on enrollments,
individual `project_repos`, avatars, idp claims); an address held by two
accounts after the union (makes roster claims ambiguous).

## 2.5 The import script

`Q:apps/api/scripts/import-classroom.ts` (task M1-06 creates it, every
porting task that adds a table extends it, M8-01 completes it).

- **Inputs**: `--source <classroom DATABASE_URL>` (read-only role),
  `--mapping <file.json>` (required: per classroom-classroom, a new course
  `{code, name}`, an existing `courseId`, or an existing `classroomId` to
  merge into), `--dry-run` (default: one transaction, rolled back, full
  report) or `--apply`.
- **Idempotency**: schema `import_classroom` with `id_map(source_table,
  source_id, target_id)` and `runs`; "insert unless it exists" on kept ids.
  A second `--apply` writes nothing. The map also feeds login adoption and
  the legacy URL resolver (M8-02).
- **Pre-flight** (refuses to `--apply` otherwise): classroom stopped, its
  queues empty, no unprocessed webhook delivery, no assignment deadline +
  grace inside the window and none overdue unapplied, identity measured,
  source consistency (enrollment status vs `user_id`, dangling grade-run
  links, group/assignment consistency, mixed-case e-mails), mapping complete,
  new course codes free.
- **Order** (foreign keys): users map and new users → addresses, claims,
  avatars, GitHub accounts, notification preferences → teacher grants
  (+ codespace grants) → GitHub orgs → new courses → classrooms (new keep
  their id; merge targets are only mapped) → classroom↔org links → course
  staff (owners, claimed seats; pending ones reported) → enrollments (kept
  or merged, remap recorded) → projects, milestones, groups → group members
  → project repos → grade runs, push receipts, bot commits, dispatches,
  reverts → classroom journal rows (re-ingested after) → webhook deliveries (30
  days) → legacy audit → role recompute → one `migration.classroom_import`
  audit row.
- **Report**: per table inserted / merged / skipped; identity (matches per
  rule, created, merged, ambiguous addresses, role changes); checks —
  repositories per project, `sum(teacher_points)`, count of frozen grades,
  every journal re-ingested with `sync_status = ok`, every grade-run link resolves, latest push receipt
  per repository equals the source.
- **Tests**: a synthetic classroom fixture (SQL dump of a seeded classroom
  database, anonymised, committed under `apps/api/scripts/fixtures/`),
  imported into a PGlite Quiz database in a `*.db.test.ts`; a second run
  writes nothing; a merge into an existing classroom.

## 2.6 A class present in both databases

The Quiz classroom row wins; the roster is the union on lowercased e-mail;
staff is the union of the classroom owner, claimed seats and the existing
course staff; several classroom-classrooms may map to one course (typically
two semesters of the same course).
