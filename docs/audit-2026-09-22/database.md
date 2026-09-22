# Database audit (agent report, relayed)

## Numbers
32 tables, 254 columns (max 23 on evaluations), 70 nullable, 0 PG enums (text + TS enum), 11 jsonb, 62 timestamptz, 1 generated column (question_versions.search tsvector), 45 indexes (12 unique, 8 partial, 3 expression, 1 GIN), 51 FKs (35 CASCADE, 4 SET NULL, 12 NO ACTION), 7 composite PKs, 2 CHECKs, 8 migrations / 478 SQL lines / 624 KB meta snapshots, schema 969 LOC in 8 db/*.ts, 21 *.db.test.ts / 7 273 LOC. No drift (drizzle-kit check OK, generate → nothing). All 8 migrations generated within 32 hours (repo first commit 2026-09-20).

jsonb: question_versions.config (validated by type schema), answers.payload (answerSchema), gradings.details (not re-validated, filterDetails), evaluations.settings / grading_scale / feedback_policy (zod-parsed on read), evaluations.released_grades (written, never read), attempt_events.details (unvalidated), notifications.payload (parsed in/out), user_idp_claims.claims, audit_log.payload.

## ER diagram
```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--o{ user_emails : has
    users ||--o| user_idp_claims : has
    users ||--o| avatars : has
    users ||--o{ api_tokens : has
    users ||--o{ teacher_grants : created
    users ||--o{ notifications : receives
    courses ||--o{ classrooms : instantiates
    courses ||--o{ course_staff : staffed_by
    users ||--o{ course_staff : seats
    courses ||--o{ course_pools : draws_from
    pools ||--o{ course_pools : feeds
    classrooms ||--o{ enrollments : roster
    users |o--o{ enrollments : claims
    users ||--o{ pools : owns
    pools ||--o{ pool_members : shared_with
    users ||--o{ pool_members : member_of
    pools ||--o{ pool_tags : vocabulary
    pools ||--o{ categories : folders
    categories ||--o{ categories : parent_of
    pools ||--o{ questions : contains
    categories |o--o{ questions : files
    questions ||--o{ questions : copied_from
    questions ||--o{ question_tags : tagged
    questions ||--o{ question_versions : versioned
    users ||--o{ question_versions : published
    pools |o--o{ assets : scoped_to
    users ||--o{ assets : uploaded
    question_versions ||--o{ question_version_assets : references
    assets ||--o{ question_version_assets : referenced_by
    classrooms ||--o{ evaluations : hosts
    users |o--o{ evaluations : created
    evaluations ||--o{ evaluation_items : contains
    question_versions ||--o{ evaluation_items : frozen_as
    evaluations ||--o{ attempts : attempted_by
    evaluations ||--o{ guest_participants : anonymous_of
    users |o--o{ attempts : owns
    guest_participants |o--o{ attempts : owns
    attempts ||--o{ attempt_events : journal
    attempts ||--o{ answers : produces
    evaluation_items ||--o{ answers : answered_by
    answers |o--o{ gradings : graded_by
    attempts ||--o{ gradings : scores
    evaluation_items ||--o{ gradings : scores
    users |o--o{ gradings : graded
    gradings ||--o{ gradings : supersedes
    answers ||--o{ answer_flags : flagged
    users ||--o{ answer_flags : flagged_by
    answers |o--o{ llm_calls : about
    audit_log {
        bigserial id
        uuid actor_user_id
    }
```
audit_log detached on purpose: actor_user_id has no FK (db/auth.ts:189).

## Findings
| id | Title | Category | Value | Conf | Risk | LOC |
|---|---|---|---|---|---|---|
| D-01 | writeGrading (grading/service.ts:126-166) = one transaction + 3 statements per cell; runEvaluationGrading (jobs.ts:143-232) loops attempts×items → 100×20 = 2 000 tx / 6 000 stmts. Fix: .returning() then batched writeGradings() | QUERIES | high | high | low | +27 (−6 000 stmt) |
| D-02 | Five sites write another module's table: grading/routes.ts:302-305 (evaluation_items, from routes!), live/service.ts:1548-1551 (evaluations.closes_at), poll/service.ts:324-331 (evaluations settings), results/service.ts:266-276/295-299/313-316 (evaluations released_*), poll/service.ts:182-193 (guest_participants). Fix: narrow writers in evaluation/service.ts, ensureGuest into live | OWNERSHIP | high | certain | low | +33 |
| D-03 | evaluations.access_code (db/evaluation.ts:75) unindexed, not unique; byCode (poll/service.ts:229-233) is the QR-scan path; freeCode (:131-140) check-then-insert up to 20×; duplicate codes possible. Fix: partial index + partial unique on (access_code) WHERE mode='poll' AND state='running' | SCHEMA | high | certain | low | −8 |
| D-04 | Dead tables: answer_flags (db/grading.ts:375-397), llm_calls (:399-421), api_tokens (db/auth.ts:154-180): zero references outside db/ | YAGNI | med-high | certain | v.low | −118 (−73 schema, −45 SQL, −28 cols) |
| D-05 | Student home five-table join written twice (live/service.ts:1900-1916 vs results/service.ts:599-615) each with an N+1 (evaluation_items per released evaluation :1926-1936; gradeOfAttempt per card :617-621 → 21 queries for 10 evaluations). Fix: shared studentEvaluationRows + grouped sum | QUERIES | med-high | certain | low | −37 |
| D-06 | evaluations.released_grades written (results/service.ts:271, nulled :297) never read; neither cache (glossary §102 says cached) nor audit record. Decide: (a) use as cache when modified_after_release=false, or (b) drop, keep audit_log | NORMALIZATION | medium | certain | low | −21 / +14 |
| D-07 | notifications → pool relation hidden in payload jsonb; listNotifications joins pools on `pools.id::text = payload->>'poolId'` (notifications/service.ts:74-76), unindexable, twice; dropPoolNotifications by jsonb predicate. Fix: pool_id uuid FK cascade | NORMALIZATION | medium | certain | low | −32 |
| D-08 | 8 migrations in 32 h; 0007_poll_guests.sql:5 ADD COLUMN token_hash NOT NULL without default (breaks on non-empty table, contra 0006's own comment); 3 auto-named; 0005 one line. Fix: squash to one 0000_init IF production holds no data worth keeping (verify: deploy.md, quiz.chevallier.io), else fix 0007 + generate --name | MIGRATIONS | medium | high | medium | −345 SQL, −540 KB |
| D-09 | enrollments.status ('pending'/'claimed') fully redundant with user_id IS NULL (all 8 writes set both; 14 read sites). Drop column | NORMALIZATION | medium | certain | low | −17 |
| D-10 | attempts.user_id ON DELETE CASCADE (db/live.ts:195) erases answers/gradings/attempt_events; enrollments.user_id is NO ACTION. Intended mechanism is users.anonymized_at (ADR-003 §5). Change to NO ACTION + test | SCHEMA | medium | high | low | +4 |
| D-11 | 3 prefix-redundant indexes: answers_attempt_idx ⊂ answers_attempt_item_uq; attempts_evaluation_idx ⊂ attempts_evaluation_user_uq; question_versions_question_idx ⊂ question_versions_question_number_uq (confirm with EXPLAIN). answers written on every autosave | SCHEMA | medium | high | v.low | −3 |
| D-12 | gradingQueue (grading/service.ts:350-447) no pagination, loads historyOf incl. superseded, renders studentView+solutionView per cell, filters state after building. Keyset pagination (touches contracts + GradingPanel CC 40) | QUERIES | medium | high | medium | +88 |
| D-13 | saveAnswer (live/service.ts:903-980) loads all items via joinedItems twice (itemOf :797-805, lock check :922-927) + all answers per autosave. Direct WHERE id=? and pass ordered list | QUERIES | medium | certain | low | +6 (−2 stmt/save) |
| D-14 | autoStartFullLobbies (live/service.ts:2034-2050) every second selects all lobby evaluations, filters settings.lobby in JS, one enrolledCount per survivor; autoCloseDue likewise. Push jsonb predicate into WHERE + grouped count | QUERIES | low-med | certain | low | +2 |
| D-15 | audit_log write-only (63 actions, one INSERT audit.ts:98, no SELECT), 0 indexes. Decide: index + admin read route, or document as psql forensics | SCHEMA/YAGNI | low-med | certain | low | +4 / +3 |
| D-16 | "released" has two truths: state='released' (read live/service.ts:552) vs released_at IS NOT NULL (7 sites); unreleaseResults (:290-300) two statements outside a transaction; releaseResults wraps one UPDATE in a transaction. Make released_at the truth | NORMALIZATION | low-med | high | low | −6 |
| D-17 | HOUSEKEEPING_QUEUE (jobs.ts:18, created :178) never sent/worked | ENV/YAGNI | low | certain | none | −4 |
| D-18 | attempt_events unbounded (logVisibility default true, contracts/evaluation.ts:83), no purge. Daily ticker delete > 180 days | SCHEMA | low | high | low | +10 |
| D-19 | seed.ts inserts courses/course_staff/classrooms/enrollments raw (:63-105) contra CLAUDE.md "never by raw inserts" | OWNERSHIP | low | certain | none | −20 |
| D-20 | evaluations.mcq_policy a column (db/evaluation.ts:67-71, added by 0005) while every other setting is in settings jsonb; users.mcq_policy likewise. Move into grading_scale/settings | SCHEMA | low | certain | low | −12 |
| D-21 | avatars.data bytea in PG vs question assets on disk; avatar is the outlier (spec §5.1). Only in squash window | SCHEMA | low | certain | low | +11 |
| D-22 | drizzle.config.ts:11 fallback `postgres://quiz:quiz@localhost:5432/quiz` — `drizzle-kit migrate` without DATABASE_URL silently targets localhost | ENV | low | certain | low | −1 |

## Plan
Phase 1 (free wins): D-01 step 1, D-17, D-11, D-22, D-16 partial (≈ −20 LOC). Phase 2 (lecture-hall queries): D-03, D-05, D-13, D-01 step 2, D-14 (≈ −40 LOC, grading pass 50× fewer round trips). Phase 3 (schema, one migration, ideally the squash): D-04, D-07, D-09, D-10, D-20, D-21, D-08 (only after confirming production data) (≈ −150 LOC, −3 tables, −31 columns). Phase 4 (decisions): D-06, D-15, D-12, D-18, D-19.

## Keep as is
text + TS enums (no PG ENUM); the 8 partial indexes (business invariants under concurrency); attempts.state stored (ticker index predicate + atomic claim); gradings.attempt_id/item_id denormalised (F-GRADE-01 grades a missing answer); evaluation_items.question_version_id NO ACTION (F-EVAL-03); the three jsonb columns on evaluations; question_versions.search generated tsvector + GIN; the PGlite/PostgreSQL bridge (~135 LOC: client.ts branch, config refusals, InProcessQueue) — buys container-free dev and tests on the real migrations; pg-boss for exactly two queues with inline fallback; no drift, keep the check in CI.

## Totals
32 → 29 tables, 254 → ~220 columns, 45 → 42 indexes, 8 → 1 migration (478 → ~135 SQL lines, −540 KB snapshots), ≈ −450 LOC across schema/services/migrations; grading pass ~6 000 → ~6 statements; poll join and notification inbox indexed.
