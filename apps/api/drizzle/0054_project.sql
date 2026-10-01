CREATE TABLE "bot_commits" (
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_commits_repo_id_sha_pk" PRIMARY KEY("repo_id","sha")
);
--> statement-breakpoint
CREATE TABLE "grade_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"checkpoint_id" uuid,
	"sha" text NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"offset_days" integer,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_grade_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"workflow_run_id" bigint NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"head_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"conclusion" text NOT NULL,
	"points" double precision,
	"max" double precision,
	"tests_passed" integer,
	"tests_total" integer,
	"parse_status" text NOT NULL,
	"kind" text DEFAULT 'ci' NOT NULL,
	"after_deadline" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid,
	"github_repo_id" bigint,
	"full_name" text,
	"default_branch" text,
	"provision_status" text DEFAULT 'pending' NOT NULL,
	"provision_error" text,
	"provision_claimed_at" timestamp with time zone,
	"accepted_at" timestamp with time zone NOT NULL,
	"invitation_status" text DEFAULT 'none' NOT NULL,
	"locked_at" timestamp with time zone,
	"ruleset_id" bigint,
	"last_commit_sha" text,
	"last_commit_at" timestamp with time zone,
	"ci_status" text DEFAULT 'none' NOT NULL,
	"sync_pr_number" integer,
	"sync_pr_state" text,
	"current_grade_run_id" uuid,
	"frozen_grade_run_id" uuid,
	"review_grade_run_id" uuid,
	"teacher_points" double precision,
	"teacher_comment" text,
	"teacher_graded_by" uuid,
	"teacher_graded_at" timestamp with time zone,
	"released_points" double precision,
	"released_max" double precision,
	"protection_suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_repos_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"grace_minutes" integer DEFAULT 30 NOT NULL,
	"source_repo_id" bigint NOT NULL,
	"source_full_name" text NOT NULL,
	"distribution_repo_id" bigint,
	"distribution_full_name" text,
	"source_strategy" text DEFAULT 'squash' NOT NULL,
	"deadline_strategy" text DEFAULT 'lock' NOT NULL,
	"grading_mode" text DEFAULT 'auto' NOT NULL,
	"publish_mode" text DEFAULT 'manual' NOT NULL,
	"duration_minutes" integer,
	"group_mode" boolean DEFAULT false NOT NULL,
	"group_max_size" integer,
	"branches" text[] NOT NULL,
	"protected_files" text[] NOT NULL,
	"source_ahead_sha" text,
	"source_pushed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"grading_scale" jsonb NOT NULL,
	"deadline_applied_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"review_dispatched_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reverts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"revert_sha" text NOT NULL,
	"files" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_commits" ADD CONSTRAINT "bot_commits_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD CONSTRAINT "grade_dispatches_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD CONSTRAINT "grade_dispatches_checkpoint_id_project_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."project_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkpoints" ADD CONSTRAINT "project_checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grade_runs" ADD CONSTRAINT "project_grade_runs_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_group_members" ADD CONSTRAINT "project_group_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_group_members" ADD CONSTRAINT "project_group_members_group_id_project_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."project_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_group_members" ADD CONSTRAINT "project_group_members_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_groups" ADD CONSTRAINT "project_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_group_id_project_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."project_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_teacher_graded_by_users_id_fk" FOREIGN KEY ("teacher_graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_github_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."github_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reverts" ADD CONSTRAINT "reverts_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_dispatches_repo_trigger_uq" ON "grade_dispatches" USING btree ("repo_id","trigger",coalesce("checkpoint_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "project_checkpoints_project_name_uq" ON "project_checkpoints" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "project_checkpoints_due_idx" ON "project_checkpoints" USING btree ("due_at") WHERE "project_checkpoints"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_grade_runs_repo_run_attempt_uq" ON "project_grade_runs" USING btree ("repo_id","workflow_run_id","run_attempt");--> statement-breakpoint
CREATE INDEX "project_grade_runs_selection_idx" ON "project_grade_runs" USING btree ("repo_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_group_members_project_enrollment_uq" ON "project_group_members" USING btree ("project_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "project_group_members_group_idx" ON "project_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "project_group_members_enrollment_idx" ON "project_group_members" USING btree ("enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_groups_project_name_uq" ON "project_groups" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_groups_project_slug_uq" ON "project_groups" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "project_repos_project_user_uq" ON "project_repos" USING btree ("project_id","user_id") WHERE "project_repos"."group_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_repos_project_group_uq" ON "project_repos" USING btree ("project_id","group_id") WHERE "project_repos"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_repos_group_idx" ON "project_repos" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "project_repos_user_idx" ON "project_repos" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_classroom_slug_uq" ON "projects" USING btree ("classroom_id","slug");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "projects_deadline_due_idx" ON "projects" USING btree ("deadline_at") WHERE "projects"."state" = 'published' AND "projects"."deadline_applied_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_freeze_due_idx" ON "projects" USING btree ("deadline_at") WHERE "projects"."deadline_applied_at" IS NOT NULL AND "projects"."frozen_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_review_due_idx" ON "projects" USING btree ("frozen_at") WHERE "projects"."frozen_at" IS NOT NULL AND "projects"."review_dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_scheduled_publish_idx" ON "projects" USING btree ("start_at") WHERE "projects"."state" = 'draft' AND "projects"."publish_mode" = 'scheduled' AND "projects"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reverts_repo_time_idx" ON "reverts" USING btree ("repo_id","created_at");