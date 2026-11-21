# Database audit and remediation plan (2026-11-21)

Status: **accepted by the product owner on 2026-11-21; Phases 0, 1 and the
expand step of Phase 4 in production** (§7 tracks what is done; §6 holds
the owner's decisions). Audited state: `origin/main` at
migration `0150` (111 tables, 1036 columns, 215 foreign keys, 294 indexes),
plus production's catalog statistics and, for Phase 0, counts only (no
personal data was read).

The one non-negotiable goal: **no production data is lost**, not by a
migration, not by a fix-up, not by a rollback.

## 1. Findings in short

What holds: every table has a primary key, every timestamp is `timestamptz`,
no redundant index, partial unique indexes guard the state machines, grades
are append-only (`supersedes_id`), the audit log is immutable by trigger,
secrets are stored hashed.

| # | Finding | Severity |
|---|---|---|
| F1 | ~80 enum-like `text` columns (state, role, kind…), 7 with a `CHECK`; `users.role`, `course_staff.role`, `sessions.kind`, `attempts.state`, `gradings.state` are guarded by TypeScript only | high |
| F2 | Duplicated parent keys never cross-checked: `gradings(answer_id, attempt_id, item_id)`, `answers(attempt_id, item_id)`, `project_group_members(project_id, group_id)`, `project_repos(project_id, group_id)` | high |
| F3 | References without a foreign key: `project_repos.{current,frozen,review}_grade_run_id`, `project_criterion_grades.pass_id`, `attempts.{last,shown}_item_id` | medium |
| F4 | E-mail normalization (trim + lowercase) is a convention; the unique keys of `enrollments`, `teacher_grants`, `user_emails` are case-sensitive | medium |
| F5 | Points are `numeric(6,2)` in `gradings`/`project_criterion_grades` but `float8` in `project_repos` and `project_grade_runs` | medium |
| F6 | 138 `ON DELETE CASCADE`: deleting a course erases its attempts, grades and projects in one statement; the only way back is a restore | product decision |
| F7 | Catch-all tables: `projects` 58 columns (32 nullable), `project_repos` 49 (42 nullable): configuration, job leases, sync state, grading, adjustment and the released snapshot in one row. 938,920 updates on 1,069 `project_repos` rows | high |
| F8 | No "activity" entity: the `evaluation_id XOR project_id` arc is repeated in five tables; `contestations` and `project_contestations` mirror each other | design (ADR) |
| F9 | `notifications` keeps its kind in `payload->>'kind'`: ten partial unique indexes, one migration per deduplicated kind | low |
| F10 | `project_repos.user_id` means "owner" for a solo repository and "first to accept" for a group's | low |
| F11 | Naming/types: `enrollments.nom/prenom`, `drill_new_unlocks.day` as `timestamptz`, `classrooms.period_*` as regex-checked text, hashes as `char(64)` or `text` | low |
| F12 | No plain index on `project_repos(project_id)` (partial ones only): 21.5 M sequential scans, 17 billion rows read; same gap on `grade_dispatches(repo_id)`, `attempts(user_id)`, `answer_acceptances(item_id)` | medium (grows with use) |
| F13 | No `pg_stat_statements`, no slow-query log; `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` all 0 | high (blind) |
| F14 | PostgreSQL sized for a 50 MB database (`shared_buffers` 32 MB, `work_mem` 2 MB); the database is 172 MB | medium |
| F15 | The `import_classroom` schema (2 tables) left from the merge | low |

## 2. Production as measured (2026-11-21)

- VM: **1 vCPU, 1.9 GB RAM, 0.5 GB of the 2 GB swap in use**, 807 MB
  available. It also hosts the staging stack (its own rootless Docker), the
  TB application and the RAD portal. Disk 35 % of 38 GB.
- PostgreSQL 17, 65 MB resident; database 172 MB, of which
  `webhook_deliveries` is 61 MB (TOAST, purged at 30 days: fine).
- Backups: daily `pg_dump -Fc` (~23 MB, 30 days), off-site borg every
  night, Hetzner daily VM backup. **RPO 24 h.**
- **The pre-migration dump is a manual step** (deployment guide §6):
  `deploy.sh` does not take one. Migrations run at application start,
  in one transaction (a failed migration rolls back whole).

The third point drives the safety net. A failing migration is harmless. The
dangerous one succeeds but transforms data wrongly: every write after it then
lands on wrong data, and restoring the last dump loses those writes.

## 3. Safety rules (every phase)

1. **A dump before every migration, automatically.** `deploy.sh` compares
   the image's migration journal with `drizzle.__drizzle_migrations`. When a
   migration is pending, it dumps to `backups/pre-<tag>-<date>.dump` and
   **refuses to start the new image if the dump fails**.
2. **Expand, then contract, never in the same release.** A release adds:
   tables, columns, constraints, a backfill. Removal (old columns, trigger)
   comes in a later release, at least a week after the expand ran in
   production, once a verification query returns zero differences and a
   fresh dump was taken.
3. **No value is changed without a copy.** Every fix-up (normalizing an
   address, nulling an orphan reference, rounding a float) first copies the
   old value into `remediation_log(migration, table_name, row_key, column_name,
   old_value jsonb, logged_at)`. That table stays until the owner drops it
   (proposal: end of the academic year).
4. **Rehearsed on production-shaped data.** Before each schema PR, refresh
   staging from production (pseudonymized export, existing scripts), run the
   migration there, compare the fingerprints (rule 5), then promote.
5. **Fingerprint before and after.** `scripts/db-fingerprint.sql`, read-only,
   prints per table: row count and checksums of the meaningful values (sum
   of points per grading table, count of released grades, count of
   non-null references…). Same output before and after, except where the
   migration says otherwise.
6. **Constraints are added `NOT VALID`, then `VALIDATE`d** in the same
   migration (the tables are small, the lock is brief), each one preceded
   by the read-only audit query that proves production satisfies it.
7. **One schema change per production promotion**, never while an
   evaluation is live (the deploy guard already refuses that), and the
   contract steps in a week with no project deadline.
8. Every migration that is not additive joins the deployment guide's
   rollback list in the same PR.

## 4. Phases

### Phase 0 — safety net and evidence (no schema change)

| Step | Content | Risk |
|---|---|---|
| 0.1 | `deploy.sh`: automatic pre-migration dump, deploy refused if it fails (rule 1); deployment guide updated | none |
| 0.2 | `scripts/db-fingerprint.sql` (rule 5) | none |
| 0.3 | Timed restore drill: last dump into a scratch PostgreSQL, fingerprint compared with production's | none |
| 0.4 | `scripts/db-audit.sql`, read-only, run once in production: the distinct values of every column Phase 3 constrains; addresses that are not normalized and the collisions normalizing them would create; `float8` values with more than 2 decimals; orphan references (F3); parent mismatches (F2) | none |

The result of 0.4 decides each later fix-up: no violation means no fix-up.
A collision (two roster lines that would become the same address) is
listed for the owner, never resolved automatically.

### Phase 1 — memory and PostgreSQL configuration

The VM already swaps. Tuning PostgreSQL alone would take memory from the
other services, so the VM grows first.

| Step | Content |
|---|---|
| 1.1 | Hetzner rescale, **CPU and RAM only** (the disk is kept, so scaling back stays possible), to **2 vCPU / 4 GB** at least. One reboot (~2 min), outside any evaluation; it also applies the pending kernel |
| 1.2 | `compose.prod.yml`: `shared_buffers=256MB`, `effective_cache_size=1GB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `shared_preload_libraries=pg_stat_statements`, `track_io_timing=on`, `log_min_duration_statement=500ms`, `log_lock_waits=on`, `idle_in_transaction_session_timeout=5min`; stale comment (two PostgreSQL instances at ~50 MB) corrected. One PostgreSQL restart (seconds) |
| 1.3 | `CREATE EXTENSION pg_stat_statements` once per environment, by hand and documented: PGlite does not have it, so it cannot be a Drizzle migration |
| 1.4 | After a week of statistics: an application-side `statement_timeout` on the app's pool only (not pg-boss, not the backup, not migrations), set above the measured maximum (likely 30 s) |

### Phase 2 — the hot paths (additive)

| Step | Content |
|---|---|
| 2.1 | Read `pg_stat_statements`: which statement makes the ~17,000 daily updates of `project_repos`, and which makes the sequential scans of `project_repos`, `evaluations`, `course_staff`, `questions` |
| 2.2 | Indexes: `project_repos(project_id)`, `grade_dispatches(repo_id)`, `attempts(user_id)`, `answer_acceptances(item_id)` (`CREATE INDEX`: tables are small, no `CONCURRENTLY` needed inside the migration transaction) |
| 2.3 | The no-op writers found in 2.1 write only when the value changes (`WHERE col IS DISTINCT FROM $new`) |
| 2.4 | Regression guard: a `schemaHygiene.db.test.ts` that reads the migrated catalog and fails on a foreign key without a covering index or a table without a primary key (explicit allowlist for the accepted cases) |

### Phase 3 — integrity constraints (additive)

0.4 found nothing to fix up, so Phase 3 and the indexes of 2.2 ship as ONE
additive migration, with the hygiene test of 2.4: one promotion instead of
five. 2.1 and 2.3 still wait for the statistics.

- **3.1 State and role checks (F1).** A `CHECK (col IN (...))` built from the
  same TypeScript constant the code uses, so a new value forces a migration.
  First, the columns that carry an authorization or a state machine:
  `users.role`, `course_staff.role`, `pool_members.role`, `sessions.kind`,
  `attempts.state`, `gradings.state/source`, `contestations.state`,
  `project_contestations.state`, `project_criterion_grades.state/source`,
  `projects.state`, `project_repos.provision_status`, `kiosk_pairings.state`,
  `launch_tickets.kind`, `course_pools.mode`.
- **3.2 Normalized addresses (F4).** `CHECK (email = lower(btrim(email)))`
  on `user_emails`, `enrollments`, `teacher_grants`, after the fix-up of 0.4
  (old values in `remediation_log`). `users.email` stays as the identity
  provider sends it.
- **3.3 Consistent parents (F2), without any new column.**
  - `gradings(answer_id, attempt_id, item_id)` → `answers(id, attempt_id, item_id)`.
  - `project_group_members(group_id, project_id)` → `project_groups(id, project_id)`.
  - `project_repos(group_id, project_id)` → `project_groups(id, project_id)`
    with `ON DELETE SET NULL (group_id)` (PostgreSQL ≥ 15, hand-written SQL
    if drizzle-kit cannot express the column list).

  `answers` against its attempt's evaluation would need an `evaluation_id`
  column: left out, low value.
- **3.4 Missing foreign keys (F3).** `ON DELETE SET NULL` on the three grade
  run slots and `attempts.last_item_id` (no orphan in production, 0.4).
  `attempts.shown_item_id` keeps none: `attempts_shown_ck` ties it to
  `shown_since`, so a `SET NULL` of the item alone would break the check;
  the dwell closes the interval itself. `push_receipts` keeps no foreign key on purpose (direction project →
  github, N-DATA-03). `project_criterion_grades.pass_id` keeps none either:
  0.4 found it pointing at a grade dispatch (4,898 rows) or at an evidence
  row (524), and 5,349 at a pass since forgotten (a reopen forgets its
  passes). It is the trace of the pass that wrote the row, not a reference
  to keep alive; its schema comment says so.

### Phase 4 — splitting the catch-all tables (F7, F5)

The plan follows rule 2. Each split is one table whose primary key is the
parent's id, in three releases:

1. **Expand.** The migration creates the table and copies the columns
   (`INSERT … SELECT`, same transaction). The code now reads and writes the
   new table only. A trigger on the new table mirrors every write back to
   the old columns, so an older image (rollback) still reads current values.
   The old columns are neither written by the code nor dropped.
2. **Verify** (≥ 1 week in production). A query compares old and new
   columns and must return zero rows. The fingerprint is unchanged.
3. **Contract.** After a fresh dump: drop the trigger and the old columns,
   and add the migration to the rollback list.

**`project_repos` (49 → ~33 columns), now:**

- `project_repo_grades`, owned by the grading side of the project module:
  `teacher_points, teacher_max, teacher_comment, teacher_graded_by,
  teacher_graded_at`, the six `grade_adjust_*`, `released_points,
  released_max, released_grade, released_comment,
  released_adjustment_comment`, with the `grade_adjust_whole` check.
  - The points become unconstrained `numeric` here, which fixes F5: exact,
    and never rounded. Every stored value has at most two decimals (0.4),
    but a `numeric(6,2)` would round a future computed value silently.
  - A trigger in each direction (new → old and old → new, each writing only
    what differs) keeps both copies equal through a rollback and the next
    roll-forward, with no manual step.
  - The human writes (grading screen) no longer contend with the machine's
    writes on the same row.

**`project_repos`, later and only on evidence:** the activity columns
(`last_commit_*`, `ci_status`, `sync_outcome*`, the run slots) move only if
2.1 shows they are the hot writer. The deadline and protection columns stay:
the 20 s tick's predicates (`NEEDS_WORK`) read them, and a join there would
cost more than it saves.

**`projects` (58 → ~44 columns):**

- `project_job_leases(project_id, kind, leased_at, due_at, failures)` in
  place of `deadline_job_at`, `dispatch_job_at`, `group_sync_job_at`,
  `sync_job_at`, `group_sync_due_at`, `group_sync_failures`. `claimLeases`
  already takes the column as a parameter, so the change is local, and a
  future lease needs no migration.
- `project_source_state` (1:1): `source_ahead_sha`, `source_ahead`,
  `source_pushed_at`, `source_heads`, `synced_at`, `sync_heads`,
  `sync_message`, `sync_message_at`.
- The configuration (strategies, modes, commands, criteria) stays in
  `projects`: it is what a project is.

`project_grade_runs.points/max` (`float8`, written from CI output) become
unconstrained `numeric` by an `ALTER COLUMN … TYPE numeric USING x::text::numeric`
(exact: the shortest round-trip text of the float, never the 15 digits of a
plain `::numeric`), after the same exact check.

### Phase 5 — product decisions, then work

| Item | Proposal |
|---|---|
| F6 deletion | Decided (§6.3): the services refuse deleting what holds work or grades; archive instead; ADR |
| F15 `import_classroom` | Decided (§6.4): the legacy URL resolver goes, the schema is dropped (archived first) |
| F9 notifications | A stored generated column `kind` (= `payload->>'kind'`) and one `dedupe_key`; the ten partial indexes become one. Optional |
| F10 | Document the meaning in the schema comment, or a nullable `owner_user_id` set for solo repositories only. Low priority |
| F11 `nom/prenom` | Rename to `family_name/given_name`: pure churn, a non-additive migration; proposed **not done** |
| F8 activity entity | A separate ADR; not in this plan |
| PITR | Decided (§6.6): hourly dumps and copies (RPO 1 h); WAL archiving only if needed |

## 5. Order and size

| Phase | PRs | Production impact |
|---|---|---|
| 0 | 2 (deploy dump + guide; fingerprint + audit scripts) | none |
| 1 | 1 PR + the rescale by the owner | one reboot, one PostgreSQL restart |
| 2.2, 2.4 and 3 | 1 (0.4 found nothing to fix up) | brief locks on small tables |
| 2.1, 2.3 | 1 | none |
| 4 | expand + contract per split: 3 splits → 6, plus the `project_grade_runs` type | contract steps in a week without deadlines |
| 5 | per decision | — |

Phases 0 and 1 can start right away. Phase 2 needs a week of Phase 1's
statistics. Phase 4's contract steps wait for a quiet week (semester break
at the latest).

## 6. The owner's decisions (2026-11-21)

1. **The plan, as ordered.**
2. **The VM** was rescaled to CPX22 (2 vCPU / 4 GB) by the owner the same
   evening; the runner VM went down to 16 GB, its slices re-installed.
3. **F6, deletion: refuse, no soft delete.** A soft delete would add a
   `deleted_at` filter to every query and to `staffAccess`: one forgotten
   filter shows a "deleted" course again. Instead the services refuse to
   delete an evaluation with a submitted attempt or released grades, a
   project with a graded repository, a classroom or a course holding one;
   they offer the archive (which classrooms and projects have). A draft or
   an empty classroom stays deletable. A short ADR amends F-ORG-09.
4. **F15: the legacy heig-classroom URLs are no longer needed.** The
   resolver (`modules/legacy`, which read `import_classroom.id_map`) goes,
   and the schema is dropped; its dump was archived first (internal notes,
   2026-11-21, 61 KB). `legacy_classroom_audit_log` is audit history and
   stays.
5. **F9: later**, with the next deduplicated notification kind. F10: the
   schema comment.
6. **PITR: an hourly dump first.** RPO 1 h (48 hourly dumps, 30 daily,
   the off-site copy hourly too), the backup checks warning after 3 h. WAL
   archiving only if an hour proves too much.
7. **`remediation_log`** is created only by a migration that changes a
   value, and kept one year (an academic year and its contestation
   windows).

## 7. Progress

### Phase 0 (2026-11-21)

- **0.1** `deploy.sh` dumps the database before a production deploy that
  carries a pending migration, and refuses the deploy if the dump fails
  (exit 4). Exercised against a fake compose: up to date (no dump), pending
  (dump), check failing (dump, fail closed), dump failing or empty (refused,
  checkout back to the running commit), retention (ten kept).
- **0.2** `scripts/db-fingerprint.sql`: 4 s on production.
- **0.3** `scripts/restore-drill.sh`, run on the application VM: a 24 MB
  dump in 5 s, restored in 7 s into a throwaway container, 129 of 130 lines
  identical; the odd one, `scheduled_tasks`, moved during the dump.
- **0.4** `scripts/db-audit.sql` on production, its outcome:
  - Every state and role column holds only the values its TypeScript
    constant declares (3.1 can be added as is).
  - Addresses: none unnormalized, no collision (3.2 needs no fix-up).
  - Parents: no grading, answer, contestation, group member or group
    repository disagrees with its parents (3.3 needs no fix-up).
  - The grade run slots and `attempts.{last,shown}_item_id`: no orphan, none
    pointing to another parent (3.4 needs no fix-up). `pass_id` is not a
    reference (above).
  - `float8` points of `project_repos`: none with more than two decimals,
    the largest 100. Correction (2026-11-21, after the review of #1192):
    this was first measured through `::numeric`, which keeps only 15
    significant digits. Measured through `::text::numeric` (exact),
    `project_repos` is confirmed, but `project_grade_runs.points` holds 252
    values with float noise (e.g. a sum like `0.30000000000000004`). Every
    float8 → numeric conversion of the plan casts through text, into
    unconstrained `numeric`, never `numeric(6,2)`.
  - `project_repos`: 213 rows hold a released snapshot, 16 an adjustment,
    **none a teacher score** (`teacher_points`/`teacher_max` never written
    in production).
  - `import_classroom`: `id_map` 899 rows, `runs` 1.

  So `remediation_log` has nothing to hold yet. It is created by the first
  migration that changes a value, if one ever does.

### Phases 1 and 4 (expand), and the backups (2026-11-21)

- **#1190, #1194, #1195:** the pre-migration dump. The first deploy carrying
  a migration was refused by it: under rootless Docker `backups/` belongs to
  a uid of the containers' namespace, so the dump is now written by the
  `backup` container, read back whole, mode 600. It then ran: production
  dumped (24 MB) before 0151.
- **#1192 (Phase 4, expand of `project_repo_grades`)** in production: 213
  rows, totals equal to the old columns, the verification query 0 rows. Its
  first version cast `float8::numeric`, which keeps 15 significant digits:
  caught by the review, cast through text since. The contract step comes a
  week after, at the earliest.
- **#1191 (Phase 1)** in production after the rescale: `shared_buffers`
  256 MB and the rest, `pg_stat_statements` created by hand, and the API
  survives a connection the server ends (`guardPoolErrors`).
- **#1193 (Phases 2.2, 2.4, 3, migration 0152)** reviewed and rehearsed on
  a copy of production (28 constraints validated); the next promotion.
- **Hourly dumps** (§6.6): the dump every hour (48 kept, the day's latest
  linked as the daily one), the off-site copy every hour at :15, prune
  keeping 48 hourly archives, the backup checks warning after 3 h (ADR-055
  amended). The timer unit is a copy on the VM: re-installed by hand.
