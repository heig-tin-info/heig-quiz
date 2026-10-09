-- A synthetic heig-classroom database, the source of the import of merge
-- task M1-06 (apps/api/src/import-classroom.ts,
-- docs/merge/02-data-and-migration.md §2.5). Two parts:
--
-- 1. heig-classroom's schema, exactly as production has it: its 31 Drizzle
--    migrations (apps/server/drizzle/0000…0030 at heig-classroom ab98cc0),
--    concatenated in journal order, statement breakpoints removed. To
--    refresh it after a classroom migration, concatenate them again.
-- 2. Synthetic, anonymised rows: three organizations, three classrooms (one
--    to drop), two teachers, an assistant, six students (one pending, one
--    anonymised), a development account, addresses, claims, an avatar,
--    grants and GitHub links.
--    No real person, address or account.

-- ---- heig-classroom migration 0000_complete_thunderball.sql ----
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "classrooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"nom" text NOT NULL,
	"prenom" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"claimed_at" timestamp with time zone,
	"conflict_flag" boolean DEFAULT false NOT NULL
);

CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"github_org_id" bigint NOT NULL,
	"login" text NOT NULL,
	"installation_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "organizations_github_org_id_unique" UNIQUE("github_org_id"),
	CONSTRAINT "organizations_installation_id_unique" UNIQUE("installation_id")
);

CREATE TABLE "sessions" (
	"sid_hash" char(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"oidc_sub" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"given_name" text DEFAULT '' NOT NULL,
	"family_name" text DEFAULT '' NOT NULL,
	"swiss_edu_id" text,
	"role" text DEFAULT 'student' NOT NULL,
	"github_user_id" bigint,
	"github_login" text,
	"github_linked_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"email_opt_in" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_oidc_sub_unique" UNIQUE("oidc_sub"),
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);

CREATE TABLE "webhook_deliveries" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);

ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "enrollments_classroom_email_uq" ON "enrollments" USING btree ("classroom_id","email");
CREATE UNIQUE INDEX "enrollments_classroom_user_uq" ON "enrollments" USING btree ("classroom_id","user_id");
CREATE INDEX "enrollments_email_idx" ON "enrollments" USING btree (lower("email"));
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
CREATE INDEX "users_email_idx" ON "users" USING btree (lower("email"));
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("received_at") WHERE "webhook_deliveries"."processed_at" IS NULL;

-- ---- heig-classroom migration 0001_jazzy_shiva.sql ----
ALTER TABLE "organizations" ALTER COLUMN "github_org_id" DROP NOT NULL;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_login_unique" UNIQUE("login");

-- ---- heig-classroom migration 0002_curious_leo.sql ----
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"grace_minutes" integer DEFAULT 30 NOT NULL,
	"source_repo_id" bigint NOT NULL,
	"source_full_name" text NOT NULL,
	"squashed_repo_id" bigint,
	"squashed_full_name" text,
	"source_strategy" text DEFAULT 'squash' NOT NULL,
	"deadline_strategy" text DEFAULT 'lock' NOT NULL,
	"branches" text[] NOT NULL,
	"protected_files" text[] NOT NULL,
	"source_ahead_sha" text,
	"deadline_applied_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "assignments_classroom_slug_uq" ON "assignments" USING btree ("classroom_id","slug");
CREATE INDEX "assignments_deadline_pending_idx" ON "assignments" USING btree ("deadline_at") WHERE "assignments"."state" = 'published' AND "assignments"."deadline_applied_at" IS NULL;
CREATE INDEX "assignments_freeze_pending_idx" ON "assignments" USING btree ("deadline_at") WHERE "assignments"."deadline_applied_at" IS NOT NULL AND "assignments"."frozen_at" IS NULL;

-- ---- heig-classroom migration 0003_wakeful_hercules.sql ----
ALTER TABLE "assignments" ADD COLUMN "archived_at" timestamp with time zone;

-- ---- heig-classroom migration 0004_wealthy_prodigy.sql ----
CREATE TABLE "student_repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"github_repo_id" bigint,
	"full_name" text,
	"default_branch" text,
	"provision_status" text DEFAULT 'pending' NOT NULL,
	"provision_error" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invitation_status" text DEFAULT 'none' NOT NULL,
	"locked_at" timestamp with time zone,
	"ruleset_id" bigint,
	"last_commit_sha" text,
	"last_commit_at" timestamp with time zone,
	"ci_status" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "student_repos_github_repo_id_unique" UNIQUE("github_repo_id")
);

ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "student_repos_assignment_user_uq" ON "student_repos" USING btree ("assignment_id","user_id");

-- ---- heig-classroom migration 0005_teacher-grants.sql ----
CREATE TABLE "teacher_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_grants_email_unique" UNIQUE("email")
);

ALTER TABLE "teacher_grants" ADD CONSTRAINT "teacher_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

-- ---- heig-classroom migration 0006_avatars.sql ----
CREATE TABLE "avatars" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"content_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "users" ADD COLUMN "picture_url" text;
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

-- ---- heig-classroom migration 0007_classroom-archive.sql ----
ALTER TABLE "classrooms" ADD COLUMN "archived_at" timestamp with time zone;

-- ---- heig-classroom migration 0008_m3-webhooks.sql ----
CREATE TABLE "bot_commits" (
	"student_repo_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "push_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"head_sha" char(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"forced" boolean DEFAULT false NOT NULL
);

CREATE TABLE "reverts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"revert_sha" char(40) NOT NULL,
	"files" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "bot_commits" ADD CONSTRAINT "bot_commits_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "push_receipts" ADD CONSTRAINT "push_receipts_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "reverts" ADD CONSTRAINT "reverts_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "bot_commits_pk" ON "bot_commits" USING btree ("student_repo_id","sha");
CREATE UNIQUE INDEX "push_receipts_repo_sha_uq" ON "push_receipts" USING btree ("student_repo_id","head_sha");
CREATE INDEX "reverts_repo_time_idx" ON "reverts" USING btree ("student_repo_id","created_at");

-- ---- heig-classroom migration 0009_scheduled-tasks.sql ----
CREATE TABLE "scheduled_tasks" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_duration_ms" integer
);

-- ---- heig-classroom migration 0010_grade-runs.sql ----
CREATE TABLE "grade_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"workflow_run_id" bigint NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"head_branch" text NOT NULL,
	"head_sha" char(40) NOT NULL,
	"conclusion" text NOT NULL,
	"grade_points" double precision,
	"grade_max" double precision,
	"parse_status" text NOT NULL,
	"after_deadline" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "student_repos" ADD COLUMN "current_grade_run_id" uuid;
ALTER TABLE "student_repos" ADD COLUMN "frozen_grade_run_id" uuid;
ALTER TABLE "grade_runs" ADD CONSTRAINT "grade_runs_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "grade_runs_repo_run_attempt_uq" ON "grade_runs" USING btree ("student_repo_id","workflow_run_id","run_attempt");
CREATE INDEX "grade_runs_selection_idx" ON "grade_runs" USING btree ("student_repo_id","completed_at");

-- ---- heig-classroom migration 0011_sync-prs.sql ----
ALTER TABLE "assignments" ADD COLUMN "source_pushed_at" timestamp with time zone;
ALTER TABLE "assignments" ADD COLUMN "synced_at" timestamp with time zone;
ALTER TABLE "student_repos" ADD COLUMN "sync_pr_number" integer;
ALTER TABLE "student_repos" ADD COLUMN "sync_pr_state" text;

-- ---- heig-classroom migration 0012_user-locale.sql ----
ALTER TABLE "users" ADD COLUMN "locale" text;

-- ---- heig-classroom migration 0013_llm-grading.sql ----
CREATE TABLE "grade_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"milestone_id" uuid,
	"sha" char(40) NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "assignments" ADD COLUMN "llm_dispatched_at" timestamp with time zone;
ALTER TABLE "grade_runs" ADD COLUMN "kind" text DEFAULT 'ci' NOT NULL;
ALTER TABLE "student_repos" ADD COLUMN "llm_grade_run_id" uuid;
ALTER TABLE "grade_dispatches" ADD CONSTRAINT "grade_dispatches_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "grade_dispatches_repo_trigger_uq" ON "grade_dispatches" USING btree ("student_repo_id","trigger",coalesce("milestone_id", '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX "assignments_llm_dispatch_pending_idx" ON "assignments" USING btree ("frozen_at") WHERE "assignments"."frozen_at" IS NOT NULL AND "assignments"."llm_dispatched_at" IS NULL;
-- Assignments already frozen before this feature shipped must not fire a
-- retroactive LLM review: mark them as already dispatched.
UPDATE "assignments" SET "llm_dispatched_at" = "frozen_at" WHERE "frozen_at" IS NOT NULL;

-- ---- heig-classroom migration 0014_staff-enrollments.sql ----
ALTER TABLE "enrollments" ADD COLUMN "staff" boolean DEFAULT false NOT NULL;

-- ---- heig-classroom migration 0015_email-notifications.sql ----
ALTER TABLE "assignments" ADD COLUMN "reminder_sent_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN "email_prefs" jsonb;

-- ---- heig-classroom migration 0016_grade-run-tests.sql ----
ALTER TABLE "grade_runs" ADD COLUMN "tests_passed" integer;
ALTER TABLE "grade_runs" ADD COLUMN "tests_total" integer;

-- ---- heig-classroom migration 0017_drop-email-opt-in.sql ----
ALTER TABLE "users" DROP COLUMN "email_opt_in";

-- ---- heig-classroom migration 0018_milestones-org-plan.sql ----
CREATE TABLE "assignment_milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"offset_days" integer,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "organizations" ADD COLUMN "plan" text;
ALTER TABLE "assignment_milestones" ADD CONSTRAINT "assignment_milestones_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "assignment_milestones_assignment_name_uq" ON "assignment_milestones" USING btree ("assignment_id","name");
CREATE INDEX "assignment_milestones_due_pending_idx" ON "assignment_milestones" USING btree ("due_at") WHERE "assignment_milestones"."dispatched_at" IS NULL;

-- ---- heig-classroom migration 0019_date-format-grading-mode.sql ----
ALTER TABLE "assignments" ADD COLUMN "grading_mode" text DEFAULT 'auto' NOT NULL;
ALTER TABLE "users" ADD COLUMN "date_format" text;

-- ---- heig-classroom migration 0020_publish-mode.sql ----
ALTER TABLE "assignments" ADD COLUMN "publish_mode" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "assignments" ADD COLUMN "duration_minutes" integer;
CREATE INDEX "assignments_scheduled_publish_idx" ON "assignments" USING btree ("start_at") WHERE "assignments"."state" = 'draft' AND "assignments"."publish_mode" = 'scheduled' AND "assignments"."archived_at" IS NULL;

-- ---- heig-classroom migration 0021_grade-validation.sql ----
ALTER TABLE "assignments" ADD COLUMN "grades_validated_at" timestamp with time zone;
ALTER TABLE "assignments" ADD COLUMN "grades_validated_by" uuid;
ALTER TABLE "student_repos" ADD COLUMN "teacher_points" double precision;
ALTER TABLE "student_repos" ADD COLUMN "teacher_comment" text;
ALTER TABLE "student_repos" ADD COLUMN "teacher_graded_by" uuid;
ALTER TABLE "student_repos" ADD COLUMN "teacher_graded_at" timestamp with time zone;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_grades_validated_by_users_id_fk" FOREIGN KEY ("grades_validated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_teacher_graded_by_users_id_fk" FOREIGN KEY ("teacher_graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

-- ---- heig-classroom migration 0022_student-repo-deleted.sql ----
ALTER TABLE "student_repos" ADD COLUMN "deleted_at" timestamp with time zone;

-- ---- heig-classroom migration 0023_classroom-staff.sql ----
CREATE TABLE "classroom_staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'teacher' NOT NULL,
	"user_id" uuid,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "classroom_staff_classroom_email_uq" ON "classroom_staff" USING btree ("classroom_id","email");
CREATE INDEX "classroom_staff_user_idx" ON "classroom_staff" USING btree ("user_id");
CREATE INDEX "classroom_staff_email_idx" ON "classroom_staff" USING btree ("email");

-- ---- heig-classroom migration 0024_eduid-claims.sql ----
CREATE TABLE "user_idp_claims" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"claims" jsonb NOT NULL,
	"affiliations" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "user_idp_claims" ADD CONSTRAINT "user_idp_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

-- ---- heig-classroom migration 0025_user-email-set.sql ----
CREATE TABLE "user_emails" (
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_user_id_email_pk" PRIMARY KEY("user_id","email")
);

ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "user_emails_email_idx" ON "user_emails" USING btree ("email");
-- GH-11 backfill. Purely additive: it derives the new table from data that
-- already exists and touches no existing row. Without it every account would
-- match nothing until its next login.
-- 1. The login address of every account, with the verification the IdP gave.
INSERT INTO "user_emails" ("user_id", "email", "source", "verified")
SELECT "id", lower(trim("email")), 'login', "email_verified"
FROM "users"
WHERE trim("email") <> '' AND "anonymized_at" IS NULL
ON CONFLICT DO NOTHING;
-- 2. The institutional addresses already captured by 0024, so the students
-- who signed in during the observation phase are matched without having to
-- sign in again.
INSERT INTO "user_emails" ("user_id", "email", "source", "verified")
SELECT c."user_id", lower(trim(m.value)), 'swissEduIDLinkedAffiliationMail', true
FROM "user_idp_claims" c
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE jsonb_typeof(c."claims" -> 'swissEduIDLinkedAffiliationMail')
    WHEN 'array' THEN c."claims" -> 'swissEduIDLinkedAffiliationMail'
    ELSE '[]'::jsonb
  END
) AS m(value)
WHERE trim(m.value) <> ''
ON CONFLICT DO NOTHING;

-- ---- heig-classroom migration 0026_codespace-work-mode.sql ----
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'free' NOT NULL;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_image" text;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "browser_exam_keys" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_synced_at" timestamp with time zone;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_sync_error" text;
ALTER TABLE "teacher_grants" ADD COLUMN IF NOT EXISTS "codespace_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "teacher_grants" ADD COLUMN IF NOT EXISTS "codespace_max_active_sessions" integer DEFAULT 2 NOT NULL;

-- ---- heig-classroom migration 0027_codespace-config-key.sql ----
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_config_key" text;

-- ---- heig-classroom migration 0028_assignment-groups.sql ----
CREATE TABLE "assignment_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "assignment_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "assignments" ADD COLUMN "group_mode" boolean DEFAULT false NOT NULL;
ALTER TABLE "assignments" ADD COLUMN "group_max_size" integer;
ALTER TABLE "student_repos" ADD COLUMN "group_id" uuid;
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_group_id_assignment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."assignment_groups"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "assignment_groups" ADD CONSTRAINT "assignment_groups_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "assignment_group_members_assignment_enrollment_uq" ON "assignment_group_members" USING btree ("assignment_id","enrollment_id");
CREATE INDEX "assignment_group_members_group_idx" ON "assignment_group_members" USING btree ("group_id");
CREATE UNIQUE INDEX "assignment_groups_assignment_name_uq" ON "assignment_groups" USING btree ("assignment_id","name");
CREATE UNIQUE INDEX "assignment_groups_assignment_slug_uq" ON "assignment_groups" USING btree ("assignment_id","slug");
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_group_id_assignment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."assignment_groups"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "student_repos_group_idx" ON "student_repos" USING btree ("group_id");

-- ---- heig-classroom migration 0029_group-repos.sql ----
DROP INDEX "student_repos_assignment_user_uq";
ALTER TABLE "student_repos" ADD COLUMN "provision_claimed_at" timestamp with time zone;
CREATE UNIQUE INDEX "student_repos_assignment_group_uq" ON "student_repos" USING btree ("assignment_id","group_id") WHERE "student_repos"."group_id" IS NOT NULL;
CREATE UNIQUE INDEX "student_repos_assignment_user_uq" ON "student_repos" USING btree ("assignment_id","user_id") WHERE "student_repos"."group_id" IS NULL;

-- ---- heig-classroom migration 0030_classroom-journal.sql ----
CREATE TABLE "classroom_journals" (
	"classroom_id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_by" uuid NOT NULL
);

CREATE TABLE "journal_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "journal_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"path" text NOT NULL,
	"parent_path" text NOT NULL,
	"sort_key" text NOT NULL,
	"title" text NOT NULL,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob_sha" text NOT NULL,
	"markdown" text NOT NULL,
	"html" text NOT NULL,
	"toc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"visible_from" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"github_repo_id" bigint,
	"full_name" text NOT NULL,
	"ref" text DEFAULT 'main' NOT NULL,
	"root_path" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_commit_sha" text,
	"last_synced_at" timestamp with time zone,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text
);

ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "journal_assets" ADD CONSTRAINT "journal_assets_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "journal_pages" ADD CONSTRAINT "journal_pages_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "journals" ADD CONSTRAINT "journals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "journal_assets_journal_path_uq" ON "journal_assets" USING btree ("journal_id","path");
CREATE UNIQUE INDEX "journal_pages_journal_path_uq" ON "journal_pages" USING btree ("journal_id","path");
CREATE INDEX "journal_pages_nav_idx" ON "journal_pages" USING btree ("journal_id","parent_path","sort_key");
CREATE UNIQUE INDEX "journals_repo_ref_uq" ON "journals" USING btree ("github_repo_id","ref");
CREATE UNIQUE INDEX "journals_full_name_ref_uq" ON "journals" USING btree (lower("full_name"),"ref");
-- ---- Synthetic data -------------------------------------------------------
-- Every person, address, identifier and GitHub account below is invented.
-- Ids: c1… users, c2… organizations, c3… classrooms, c4… staff seats,
-- c5… enrollments, c6… teacher grants.

INSERT INTO "users" ("id", "oidc_sub", "email", "email_verified", "given_name", "family_name", "swiss_edu_id", "role", "github_user_id", "github_login", "github_linked_at", "last_login_at", "locale", "date_format", "email_prefs", "anonymized_at", "created_at") VALUES
  ('c1000000-0000-4000-8000-000000000001', 'cr-sub-admin', 'root.admin@heig-vd.ch', true, 'Root', 'Admin', 'eid-admin@eduid.ch', 'admin', NULL, NULL, NULL, '2026-09-01 08:00:00+00', 'en', NULL, NULL, NULL, '2026-02-01 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000002', 'cr-sub-t1', 'ada.lovelace@heig-vd.ch', true, 'Ada', 'Lovelace', 'eid-t1@eduid.ch', 'teacher', 4001, 'ada-gh', '2026-03-01 08:00:00+00', '2026-09-20 08:00:00+00', 'fr', 'eu', NULL, NULL, '2026-02-02 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000003', 'cr-sub-t2', 'grace.hopper@heig-vd.ch', true, 'Grace', 'Hopper', 'eid-t2@eduid.ch', 'teacher', NULL, NULL, NULL, '2026-09-10 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-03 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000004', 'cr-sub-a1', 'alan.turing@heig-vd.ch', true, 'Alan', 'Turing', 'eid-a1@eduid.ch', 'student', NULL, NULL, NULL, '2026-09-11 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-04 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000011', 'cr-sub-s1', 's1.student@heig-vd.ch', true, 'Sam', 'One', 'eid-s1@eduid.ch', 'student', 5001, 'gh-s1', '2026-03-02 08:00:00+00', '2026-09-12 08:00:00+00', NULL, NULL, '{"deadline_reminder": false}', NULL, '2026-02-11 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000012', 'cr-sub-s2', 's2.private@mail.test', true, 'Sue', 'Two', NULL, 'student', 5002, 'gh-s2', '2026-03-03 08:00:00+00', '2026-09-13 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-12 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000013', 'cr-sub-s3', 's3.student@heig-vd.ch', true, 'Sid', 'Three', 'eid-s3@eduid.ch', 'student', 5003, 'gh-s3', '2026-03-04 08:00:00+00', '2026-09-14 08:00:00+00', 'fr', NULL, NULL, NULL, '2026-02-13 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000014', 'cr-sub-s4', 's4.private@mail.test', true, 'Sol', 'Four', 'eid-s4@eduid.ch', 'student', NULL, NULL, NULL, '2026-09-15 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-14 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000015', 'cr-sub-s5', 's5.student@heig-vd.ch', true, 'Sky', 'Five', 'eid-s5@eduid.ch', 'student', 5005, 'gh-s5', '2026-03-05 08:00:00+00', '2026-09-16 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-15 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000016', 'anon-c1000000-0000-4000-8000-000000000016', '', false, '', '', NULL, 'student', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-06-30 08:00:00+00', '2026-02-16 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000017', 'dev:carol', 'carol@heig.test', true, 'Carol', 'Dev', NULL, 'student', NULL, NULL, NULL, '2026-09-17 08:00:00+00', NULL, NULL, NULL, NULL, '2026-02-17 08:00:00+00');

INSERT INTO "user_emails" ("user_id", "email", "source", "verified", "first_seen_at") VALUES
  ('c1000000-0000-4000-8000-000000000001', 'root.admin@heig-vd.ch', 'login', true, '2026-02-01 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000002', 'ada.lovelace@heig-vd.ch', 'login', true, '2026-02-02 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000003', 'grace.hopper@heig-vd.ch', 'login', true, '2026-02-03 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000004', 'alan.turing@heig-vd.ch', 'login', true, '2026-02-04 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000011', 's1.student@heig-vd.ch', 'login', true, '2026-02-11 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000012', 's2.private@mail.test', 'login', true, '2026-02-12 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000012', 's2.student@heig-vd.ch', 'swissEduIDLinkedAffiliationMail', true, '2026-02-12 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000013', 's3.student@heig-vd.ch', 'login', true, '2026-02-13 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000013', 's3.old@mail.test', 'swissEduPersonPrivateMail', false, '2026-02-13 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000014', 's4.private@mail.test', 'login', true, '2026-02-14 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000014', 's4.student@heig-vd.ch', 'swissEduIDLinkedAffiliationMail', true, '2026-02-14 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000015', 's5.student@heig-vd.ch', 'login', true, '2026-02-15 08:00:00+00'),
  -- Left behind by an anonymization: classroom's routine never cleared the address set.
  ('c1000000-0000-4000-8000-000000000016', 's7.left@mail.test', 'login', true, '2026-02-16 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000017', 'carol@heig.test', 'login', true, '2026-02-17 08:00:00+00');

INSERT INTO "user_idp_claims" ("user_id", "claims", "affiliations", "updated_at") VALUES
  ('c1000000-0000-4000-8000-000000000002', '{"sub": "cr-sub-t1", "eduPersonScopedAffiliation": ["staff@heig-vd.ch"]}', '{staff@heig-vd.ch}', '2026-09-20 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000011', '{"sub": "cr-sub-s1", "eduPersonScopedAffiliation": ["student@heig-vd.ch"]}', '{student@heig-vd.ch}', '2026-09-12 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000013', '{"sub": "cr-sub-s3", "eduPersonScopedAffiliation": ["student@heig-vd.ch"]}', '{student@heig-vd.ch}', '2026-09-14 08:00:00+00');

INSERT INTO "avatars" ("user_id", "data", "content_type", "updated_at") VALUES
  ('c1000000-0000-4000-8000-000000000013', '\x89504e470d0a1a0a', 'image/png', '2026-04-01 08:00:00+00');

INSERT INTO "teacher_grants" ("id", "email", "codespace_enabled", "codespace_max_active_sessions", "created_by", "created_at") VALUES
  ('c6000000-0000-4000-8000-000000000001', 'ada.lovelace@heig-vd.ch', true, 2, 'c1000000-0000-4000-8000-000000000001', '2026-02-05 08:00:00+00'),
  ('c6000000-0000-4000-8000-000000000002', 'grace.hopper@heig-vd.ch', false, 2, 'c1000000-0000-4000-8000-000000000001', '2026-02-05 08:00:00+00');

INSERT INTO "organizations" ("id", "github_org_id", "login", "installation_id", "status", "plan") VALUES
  ('c2000000-0000-4000-8000-000000000001', 1001, 'heig-prog-a', 9001, 'active', 'team'),
  ('c2000000-0000-4000-8000-000000000002', 1002, 'heig-info1', 9002, 'active', 'free'),
  ('c2000000-0000-4000-8000-000000000003', 1003, 'heig-sandbox', 9003, 'active', 'free');

INSERT INTO "classrooms" ("id", "org_id", "teacher_id", "name", "archived_at", "created_at") VALUES
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'Prog-A', NULL, '2026-02-20 08:00:00+00'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'Info1-MI', NULL, '2026-02-21 08:00:00+00'),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'Sandbox', '2026-07-01 08:00:00+00', '2026-02-22 08:00:00+00');

INSERT INTO "classroom_staff" ("id", "classroom_id", "email", "role", "user_id", "invited_by", "created_at") VALUES
  ('c4000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'alan.turing@heig-vd.ch', 'assistant', 'c1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000002', '2026-02-25 08:00:00+00');

INSERT INTO "enrollments" ("id", "classroom_id", "nom", "prenom", "email", "status", "user_id", "claimed_at", "conflict_flag", "staff") VALUES
  ('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'One', 'Sam', 's1.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000011', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000001', 'Two', 'Sue', 's2.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000012', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001', 'Three', 'Sid', 's3.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000013', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000001', 'Six', 'Syd', 's6.student@heig-vd.ch', 'pending', NULL, NULL, false, false),
  ('c5000000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000001', 'Lovelace', 'Ada', 'ada.lovelace@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000002', '2026-02-20 08:00:00+00', false, true),
  ('c5000000-0000-4000-8000-000000000006', 'c3000000-0000-4000-8000-000000000002', 'Four', 'Sol', 's4.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000014', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000007', 'c3000000-0000-4000-8000-000000000002', 'Seven', 'Sol', 's7.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000016', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000008', 'c3000000-0000-4000-8000-000000000003', 'Five', 'Sky', 's5.student@heig-vd.ch', 'claimed', 'c1000000-0000-4000-8000-000000000015', '2026-03-01 08:00:00+00', false, false),
  ('c5000000-0000-4000-8000-000000000009', 'c3000000-0000-4000-8000-000000000002', 'Dev', 'Carol', 'carol@heig.test', 'claimed', 'c1000000-0000-4000-8000-000000000017', '2026-03-01 08:00:00+00', false, false);

-- ---- Synthetic data, part 2 (M8-01a): what the import's frame reads --------
-- Ids: c7… assignments, c8… student repositories, c9… grade runs,
-- ca… groups, cb… group members, cc… webhook deliveries. Three assignments
-- in carried classrooms (a published one with a far deadline, a group one, a
-- frozen one) and a draft in the dropped classroom; their repositories, grade
-- runs and a group; a quiet source (no recent webhook or task, an empty
-- queue, nothing unprocessed); and a short audit log. Later parts of M8-01
-- (projects, journals, webhooks) grow it.

INSERT INTO "assignments" ("id", "classroom_id", "name", "slug", "state", "start_at", "deadline_at", "grace_minutes", "source_repo_id", "source_full_name", "branches", "protected_files", "deadline_applied_at", "frozen_at", "group_mode", "group_max_size", "created_at") VALUES
  ('c7000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Project Alpha', 'alpha', 'published', '2026-09-01 08:00:00+00', '2026-12-01 08:00:00+00', 30, 111, 'heig-prog-a/alpha-src', '{main}', '{README.md}', NULL, NULL, false, NULL, '2026-08-20 08:00:00+00'),
  ('c7000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000001', 'Pair Beta', 'beta', 'published', '2026-09-10 08:00:00+00', '2026-12-15 08:00:00+00', 30, 112, 'heig-prog-a/beta-src', '{main}', '{README.md}', NULL, NULL, true, 2, '2026-08-21 08:00:00+00'),
  ('c7000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000002', 'Lab 1', 'lab-1', 'published', '2026-09-01 08:00:00+00', '2026-09-15 08:00:00+00', 30, 113, 'heig-info1/lab-1-src', '{main}', '{README.md}', '2026-09-15 08:00:00+00', '2026-09-15 08:30:00+00', false, NULL, '2026-08-22 08:00:00+00'),
  ('c7000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000003', 'Sandbox draft', 'draft', 'draft', '2026-09-01 08:00:00+00', '2026-12-31 08:00:00+00', 30, 114, 'heig-sandbox/draft-src', '{main}', '{README.md}', NULL, NULL, false, NULL, '2026-08-23 08:00:00+00');

INSERT INTO "assignment_groups" ("id", "assignment_id", "name", "slug", "position", "created_at") VALUES
  ('ca000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'Team 1', 'team-1', 0, '2026-09-11 08:00:00+00');

INSERT INTO "assignment_group_members" ("id", "assignment_id", "group_id", "enrollment_id", "added_at") VALUES
  ('cb000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', '2026-09-11 08:00:00+00'),
  ('cb000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', '2026-09-11 08:00:00+00');

INSERT INTO "student_repos" ("id", "assignment_id", "user_id", "group_id", "github_repo_id", "full_name", "default_branch", "provision_status", "current_grade_run_id", "frozen_grade_run_id") VALUES
  ('c8000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000011', NULL, 9001, 'heig-prog-a/alpha-s1', 'main', 'ok', 'c9000000-0000-4000-8000-000000000001', NULL),
  ('c8000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000011', 'ca000000-0000-4000-8000-000000000001', 9002, 'heig-prog-a/beta-team-1', 'main', 'ok', NULL, NULL),
  ('c8000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000014', NULL, 9003, 'heig-info1/lab-1-s4', 'main', 'ok', 'c9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000002');

INSERT INTO "grade_runs" ("id", "student_repo_id", "workflow_run_id", "head_branch", "head_sha", "conclusion", "grade_points", "grade_max", "parse_status", "completed_at") VALUES
  ('c9000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 70001, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'success', 4, 6, 'ok', '2026-09-20 10:00:00+00'),
  ('c9000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000003', 70002, 'main', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'success', 5, 6, 'ok', '2026-09-15 07:30:00+00');

INSERT INTO "webhook_deliveries" ("delivery_id", "event", "action", "payload", "received_at", "processed_at") VALUES
  ('cc000000-0000-4000-8000-000000000001', 'push', NULL, '{"ref": "refs/heads/main"}', '2026-09-20 10:00:00+00', '2026-09-20 10:00:01+00'),
  ('cc000000-0000-4000-8000-000000000002', 'workflow_run', 'completed', '{"action": "completed"}', '2026-09-20 10:05:00+00', '2026-09-20 10:05:01+00');

INSERT INTO "scheduled_tasks" ("key", "enabled", "interval_minutes", "last_run_at", "last_status") VALUES
  ('deadline-sweep', true, 1, '2026-10-01 07:00:00+00', 'ok');

-- pg-boss's queue table, reduced to what the pre-flight reads (production's
-- `pgboss.job` has more columns and an enum state); nothing unfinished here.
CREATE SCHEMA "pgboss";
CREATE TABLE "pgboss"."job" ("id" serial PRIMARY KEY, "name" text NOT NULL, "state" text NOT NULL);
INSERT INTO "pgboss"."job" ("name", "state") VALUES ('webhook.process', 'completed'), ('email.send', 'failed');

INSERT INTO "audit_log" ("actor_user_id", "actor_type", "action", "subject_type", "subject_id", "payload", "created_at") VALUES
  ('c1000000-0000-4000-8000-000000000002', 'user', 'classroom.created', 'classroom', 'c3000000-0000-4000-8000-000000000001', '{"name": "Prog-A"}', '2026-02-20 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000001', 'user', 'grant.created', 'teacher_grant', 'c6000000-0000-4000-8000-000000000001', NULL, '2026-02-05 08:00:00+00'),
  ('c1000000-0000-4000-8000-000000000004', 'user', 'staff.added', 'classroom', 'c3000000-0000-4000-8000-000000000001', '{"role": "assistant"}', '2026-02-25 08:00:00+00'),
  (NULL, 'system', 'deadline.applied', 'assignment', 'c7000000-0000-4000-8000-000000000003', NULL, '2026-09-15 08:00:00+00');

-- ---- Synthetic data, part 3 (M8-01d): journals and recent deliveries ------
-- Ids: ce… journals, cf… journal pages and assets, cc…0003+ more webhook
-- deliveries. Prog-A reads a journal of its own organization (with pages and
-- an asset, which the import never copies); Info1-MI a journal of its own
-- organization on another branch and folder; the dropped Sandbox one whose
-- repository id is not resolved. The deliveries: two processed within the
-- 30 days before 2026-10-05, one older than that.

INSERT INTO "journals" ("id", "org_id", "github_repo_id", "full_name", "ref", "root_path", "created_by", "created_at", "last_commit_sha", "last_synced_at", "sync_status", "sync_error") VALUES
  ('ce000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 2001, 'heig-prog-a/journal', 'main', 'docs', 'c1000000-0000-4000-8000-000000000002', '2026-03-01 08:00:00+00', 'ffffffffffffffffffffffffffffffffffffffff', '2026-09-30 08:00:00+00', 'ok', NULL),
  ('ce000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 2002, 'heig-info1/handouts', 'spring', '', 'c1000000-0000-4000-8000-000000000002', '2026-03-02 08:00:00+00', NULL, NULL, 'error', 'Repository not found for this installation'),
  ('ce000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', NULL, 'heig-sandbox/journal', 'main', '', 'c1000000-0000-4000-8000-000000000003', '2026-03-03 08:00:00+00', NULL, NULL, 'pending', NULL);

INSERT INTO "classroom_journals" ("classroom_id", "journal_id", "attached_at", "attached_by") VALUES
  ('c3000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', '2026-03-01 09:00:00+00', 'c1000000-0000-4000-8000-000000000002'),
  ('c3000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000002', '2026-03-02 09:00:00+00', 'c1000000-0000-4000-8000-000000000002'),
  ('c3000000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000003', '2026-03-03 09:00:00+00', 'c1000000-0000-4000-8000-000000000003');

INSERT INTO "journal_pages" ("id", "journal_id", "path", "parent_path", "sort_key", "title", "blob_sha", "markdown", "html") VALUES
  ('cf000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'index.md', '', 'index.md', 'Welcome', 'aaaa000000000000000000000000000000000001', '# Welcome', '<h1>Welcome</h1>'),
  ('cf000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000001', 'week-1.md', '', 'week-1.md', 'Week 1', 'aaaa000000000000000000000000000000000002', '# Week 1', '<h1>Week 1</h1>');

INSERT INTO "journal_assets" ("id", "journal_id", "path", "blob_sha", "content_type", "size", "data") VALUES
  ('cf000000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000001', 'img/logo.png', 'bbbb000000000000000000000000000000000001', 'image/png', 3, '\x010203');

INSERT INTO "webhook_deliveries" ("delivery_id", "event", "action", "payload", "received_at", "processed_at", "error") VALUES
  ('cc000000-0000-4000-8000-000000000003', 'push', NULL, '{"ref": "refs/heads/main", "after": "ffffffffffffffffffffffffffffffffffffffff"}', '2026-09-28 10:00:00+00', '2026-09-28 10:00:02+00', NULL),
  ('cc000000-0000-4000-8000-000000000004', 'repository', 'renamed', '{"action": "renamed"}', '2026-09-29 10:00:00+00', '2026-09-29 10:00:01+00', 'handler failed once'),
  ('cc000000-0000-4000-8000-000000000005', 'push', NULL, '{"ref": "refs/heads/main"}', '2026-08-01 10:00:00+00', '2026-08-01 10:00:01+00', NULL);

-- ---- Synthetic data, part 3 (M8-01b): the projects' repositories and what hangs on them ----
-- Ids: cf… milestones, cd… push receipts, ce… ledger rows, d0… reverts; the
-- c8… repositories and c9… runs of part 2 grow. Alpha (published, a
-- milestone dispatched, one never confirmed); Pair Beta (a group repository,
-- two individual repositories inside it: one live, one pending); Lab 1
-- (applied, frozen, final review dispatched, released: a repository with its
-- ledger row, one without (the synthetic rule), a development account's).

UPDATE "assignments" SET "squashed_repo_id" = 211, "squashed_full_name" = 'heig-prog-a/alpha-squashed',
  "source_pushed_at" = '2026-09-18 09:00:00+00', "synced_at" = '2026-09-19 12:00:00+00',
  "source_ahead_sha" = repeat('d', 40)
  WHERE "id" = 'c7000000-0000-4000-8000-000000000001';
UPDATE "assignments" SET "squashed_repo_id" = 212, "squashed_full_name" = 'heig-prog-a/beta-squashed'
  WHERE "id" = 'c7000000-0000-4000-8000-000000000002';
UPDATE "assignments" SET "squashed_repo_id" = 213, "squashed_full_name" = 'heig-info1/lab-1-squashed',
  "deadline_strategy" = 'commit', "llm_dispatched_at" = '2026-09-15 09:00:00+00',
  "grades_validated_at" = '2026-09-16 10:00:00+00', "grades_validated_by" = 'c1000000-0000-4000-8000-000000000002'
  WHERE "id" = 'c7000000-0000-4000-8000-000000000003';

INSERT INTO "assignment_milestones" ("id", "assignment_id", "name", "due_at", "offset_days", "dispatched_at", "created_at") VALUES
  ('cf000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'midterm', '2026-10-01 08:00:00+00', NULL, '2026-10-01 08:00:30+00', '2026-09-02 08:00:00+00'),
  ('cf000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001', 'final-check', '2026-11-20 08:00:00+00', -11, NULL, '2026-09-02 08:00:00+00');

INSERT INTO "student_repos" ("id", "assignment_id", "user_id", "group_id", "github_repo_id", "full_name", "default_branch", "provision_status", "accepted_at", "invitation_status") VALUES
  ('c8000000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000012', NULL, 9004, 'heig-prog-a/alpha-s2', 'main', 'ok', '2026-09-03 08:00:00+00', 'accepted'),
  ('c8000000-0000-4000-8000-000000000005', 'c7000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000013', NULL, NULL, NULL, NULL, 'pending', '2026-09-04 08:00:00+00', 'none'),
  ('c8000000-0000-4000-8000-000000000006', 'c7000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000012', NULL, 9006, 'heig-prog-a/beta-s2', 'main', 'ok', '2026-09-05 08:00:00+00', 'accepted'),
  ('c8000000-0000-4000-8000-000000000007', 'c7000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000013', NULL, NULL, NULL, NULL, 'pending', '2026-09-05 09:00:00+00', 'none'),
  ('c8000000-0000-4000-8000-000000000008', 'c7000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000016', NULL, 9008, 'heig-info1/lab-1-s7', 'main', 'ok', '2026-09-02 08:00:00+00', 'accepted'),
  ('c8000000-0000-4000-8000-000000000009', 'c7000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000017', NULL, 9009, 'heig-info1/lab-1-dev', 'main', 'ok', '2026-09-02 09:00:00+00', 'accepted');

INSERT INTO "grade_runs" ("id", "student_repo_id", "workflow_run_id", "run_attempt", "head_branch", "head_sha", "conclusion", "grade_points", "grade_max", "tests_passed", "tests_total", "parse_status", "kind", "after_deadline", "completed_at", "created_at") VALUES
  ('c9000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000003', 70003, 1, 'main', repeat('c', 40), 'success', 5.5, 6, NULL, NULL, 'ok', 'llm', false, '2026-09-16 07:00:00+00', '2026-09-16 07:00:05+00'),
  ('c9000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-000000000008', 70004, 1, 'main', repeat('e', 40), 'success', 3, 6, 6, 10, 'ok', 'ci', false, '2026-09-15 07:45:00+00', '2026-09-15 07:45:05+00'),
  ('c9000000-0000-4000-8000-000000000005', 'c8000000-0000-4000-8000-000000000002', 70005, 1, 'main', repeat('f', 40), 'success', 2, 6, NULL, NULL, 'ok', 'ci', false, '2026-09-21 10:00:00+00', '2026-09-21 10:00:05+00'),
  ('c9000000-0000-4000-8000-000000000006', 'c8000000-0000-4000-8000-000000000004', 70006, 2, 'main', repeat('1', 40), 'failure', NULL, NULL, NULL, NULL, 'malformed', 'ci', true, '2026-09-22 10:00:00+00', '2026-09-22 10:00:05+00');

UPDATE "student_repos" SET "invitation_status" = 'accepted', "ruleset_id" = 5001, "last_commit_sha" = repeat('2', 40),
  "last_commit_at" = '2026-09-20 10:00:00+00', "ci_status" = 'pass', "accepted_at" = '2026-09-02 08:00:00+00',
  "sync_pr_number" = 7, "sync_pr_state" = 'open'
  WHERE "id" = 'c8000000-0000-4000-8000-000000000001';
UPDATE "student_repos" SET "accepted_at" = '2026-09-11 08:00:00+00', "invitation_status" = 'accepted', "locked_at" = NULL
  WHERE "id" = 'c8000000-0000-4000-8000-000000000002';
UPDATE "student_repos" SET "invitation_status" = 'accepted', "locked_at" = '2026-09-15 08:00:10+00',
  "llm_grade_run_id" = 'c9000000-0000-4000-8000-000000000003', "accepted_at" = '2026-09-02 08:00:00+00',
  "sync_pr_number" = 3, "sync_pr_state" = 'merged', "ci_status" = 'pass',
  "last_commit_sha" = repeat('b', 40), "last_commit_at" = '2026-09-15 07:30:00+00'
  WHERE "id" = 'c8000000-0000-4000-8000-000000000003';
UPDATE "student_repos" SET "current_grade_run_id" = 'c9000000-0000-4000-8000-000000000006',
  "teacher_points" = 5, "teacher_comment" = 'Good work', "teacher_graded_by" = 'c1000000-0000-4000-8000-000000000002',
  "teacher_graded_at" = '2026-09-25 08:00:00+00', "ci_status" = 'fail'
  WHERE "id" = 'c8000000-0000-4000-8000-000000000004';
UPDATE "student_repos" SET "current_grade_run_id" = 'c9000000-0000-4000-8000-000000000004',
  "frozen_grade_run_id" = 'c9000000-0000-4000-8000-000000000004', "locked_at" = '2026-09-15 08:00:10+00',
  "teacher_points" = 4.5, "teacher_graded_by" = 'c1000000-0000-4000-8000-000000000002',
  "teacher_graded_at" = '2026-09-16 09:00:00+00'
  WHERE "id" = 'c8000000-0000-4000-8000-000000000008';
-- Repository 2 (a group's) holds a run, a commit and a receipt too: all left out until M8-01c.
UPDATE "student_repos" SET "current_grade_run_id" = 'c9000000-0000-4000-8000-000000000005'
  WHERE "id" = 'c8000000-0000-4000-8000-000000000002';

INSERT INTO "push_receipts" ("id", "student_repo_id", "branch", "head_sha", "received_at", "is_bot", "forced") VALUES
  ('cd000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'main', repeat('3', 40), '2026-09-19 09:00:00+00', true, false),
  ('cd000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001', 'main', repeat('1', 40), '2026-09-20 09:00:00+00', false, false),
  ('cd000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000001', 'main', repeat('2', 40), '2026-09-20 10:00:00+00', false, true),
  ('cd000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-000000000003', 'main', repeat('4', 40), '2026-09-15 07:00:00+00', false, false),
  ('cd000000-0000-4000-8000-000000000005', 'c8000000-0000-4000-8000-000000000005', 'main', repeat('5', 40), '2026-09-04 09:00:00+00', false, false),
  ('cd000000-0000-4000-8000-000000000006', 'c8000000-0000-4000-8000-000000000002', 'main', repeat('6', 40), '2026-09-21 09:00:00+00', false, false);

INSERT INTO "bot_commits" ("student_repo_id", "sha", "kind", "created_at") VALUES
  ('c8000000-0000-4000-8000-000000000001', repeat('3', 40), 'revert', '2026-09-19 09:00:00+00'),
  ('c8000000-0000-4000-8000-000000000003', repeat('8', 40), 'deadline', '2026-09-15 08:00:05+00'),
  ('c8000000-0000-4000-8000-000000000002', repeat('9', 40), 'sync', '2026-09-22 09:00:00+00');

INSERT INTO "reverts" ("id", "student_repo_id", "revert_sha", "files", "created_at") VALUES
  ('d0000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', repeat('3', 40), '{README.md}', '2026-09-19 09:00:00+00');

INSERT INTO "grade_dispatches" ("id", "student_repo_id", "trigger", "milestone_id", "sha", "dispatched_at", "created_at") VALUES
  ('ce000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000003', 'deadline', NULL, repeat('b', 40), '2026-09-15 09:00:05+00', '2026-09-15 09:00:01+00'),
  ('ce000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001', 'milestone', 'cf000000-0000-4000-8000-000000000001', repeat('2', 40), NULL, '2026-10-01 08:00:10+00'),
  ('ce000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000004', 'milestone', 'cf000000-0000-4000-8000-000000000001', repeat('1', 40), '2026-10-01 08:00:30+00', '2026-10-01 08:00:11+00');

-- ---- Synthetic data, part 4 (M8-01c): a second group assignment ----------------
-- Ids: c7…05 the assignment, ca…02/03 its groups, cb…03..06 members, c8…0a
-- repository, c9…07 run, cd…07 receipt, ce…04 ledger row, d0…02 revert. Pair
-- Gamma (Prog-A) REUSES Beta's group "Team 1" (Sam and Sue, the same membership
-- under another assignment: one set per assignment) and adds "Team 2" (Sid and
-- Syd, the roster line that is not claimed: they are missing from the Quiz
-- roster in the tests' world), whose repository does not exist yet. Its deadline
-- is past, applied and frozen: its copy is stopped. Team 1's repository was
-- made by Sue (who keeps no individual repository here, so she is invited).

INSERT INTO "assignments" ("id", "classroom_id", "name", "slug", "state", "start_at", "deadline_at", "grace_minutes", "source_repo_id", "source_full_name", "branches", "protected_files", "deadline_applied_at", "frozen_at", "group_mode", "group_max_size", "created_at") VALUES
  ('c7000000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000001', 'Pair Gamma', 'gamma', 'published', '2026-09-05 08:00:00+00', '2026-09-20 08:00:00+00', 30, 115, 'heig-prog-a/gamma-src', '{main}', '{README.md}', '2026-09-20 08:00:00+00', '2026-09-20 08:30:00+00', true, 3, '2026-08-24 08:00:00+00');

INSERT INTO "assignment_groups" ("id", "assignment_id", "name", "slug", "position", "created_at") VALUES
  ('ca000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000005', 'Team 1', 'team-1', 0, '2026-09-06 08:00:00+00'),
  ('ca000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000005', 'Team 2', 'team-2', 1, '2026-09-06 08:00:00+00');

INSERT INTO "assignment_group_members" ("id", "assignment_id", "group_id", "enrollment_id", "added_at") VALUES
  ('cb000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', '2026-09-06 08:00:00+00'),
  ('cb000000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', '2026-09-06 08:00:00+00'),
  ('cb000000-0000-4000-8000-000000000005', 'c7000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000003', 'c5000000-0000-4000-8000-000000000003', '2026-09-06 08:00:00+00'),
  ('cb000000-0000-4000-8000-000000000006', 'c7000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000003', 'c5000000-0000-4000-8000-000000000004', '2026-09-06 08:00:00+00');

UPDATE "assignments" SET "squashed_repo_id" = 215, "squashed_full_name" = 'heig-prog-a/gamma-squashed'
  WHERE "id" = 'c7000000-0000-4000-8000-000000000005';

INSERT INTO "student_repos" ("id", "assignment_id", "user_id", "group_id", "github_repo_id", "full_name", "default_branch", "provision_status", "accepted_at", "invitation_status") VALUES
  ('c8000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000012', 'ca000000-0000-4000-8000-000000000002', 9010, 'heig-prog-a/gamma-team-1', 'main', 'ok', '2026-09-07 08:00:00+00', 'accepted');

INSERT INTO "grade_runs" ("id", "student_repo_id", "workflow_run_id", "run_attempt", "head_branch", "head_sha", "conclusion", "grade_points", "grade_max", "tests_passed", "tests_total", "parse_status", "kind", "after_deadline", "completed_at", "created_at") VALUES
  ('c9000000-0000-4000-8000-000000000007', 'c8000000-0000-4000-8000-00000000000a', 70007, 1, 'main', repeat('7', 40), 'success', 4.5, 6, 9, 10, 'ok', 'ci', false, '2026-09-20 07:45:00+00', '2026-09-20 07:45:05+00');

UPDATE "student_repos" SET "current_grade_run_id" = 'c9000000-0000-4000-8000-000000000007',
  "frozen_grade_run_id" = 'c9000000-0000-4000-8000-000000000007', "locked_at" = '2026-09-20 08:00:10+00',
  "last_commit_sha" = repeat('7', 40), "last_commit_at" = '2026-09-20 07:40:00+00', "ci_status" = 'pass'
  WHERE "id" = 'c8000000-0000-4000-8000-00000000000a';

INSERT INTO "push_receipts" ("id", "student_repo_id", "branch", "head_sha", "received_at", "is_bot", "forced") VALUES
  ('cd000000-0000-4000-8000-000000000007', 'c8000000-0000-4000-8000-00000000000a', 'main', repeat('7', 40), '2026-09-20 07:40:00+00', false, false);

INSERT INTO "bot_commits" ("student_repo_id", "sha", "kind", "created_at") VALUES
  ('c8000000-0000-4000-8000-00000000000a', repeat('a', 40), 'deadline', '2026-09-20 08:00:05+00');

INSERT INTO "reverts" ("id", "student_repo_id", "revert_sha", "files", "created_at") VALUES
  ('d0000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-00000000000a', repeat('b', 40), '{README.md}', '2026-09-10 09:00:00+00');

INSERT INTO "grade_dispatches" ("id", "student_repo_id", "trigger", "milestone_id", "sha", "dispatched_at", "created_at") VALUES
  ('ce000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-00000000000a', 'deadline', NULL, repeat('7', 40), '2026-09-20 09:00:05+00', '2026-09-20 09:00:01+00');
