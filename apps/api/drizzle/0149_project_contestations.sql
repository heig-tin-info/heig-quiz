CREATE TABLE "project_contestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"criterion_description" text NOT NULL,
	"points_at_filing" numeric(6, 2) NOT NULL,
	"max_at_filing" numeric(6, 2) NOT NULL,
	"bonus_at_filing" numeric(6, 2),
	"grade_at_filing_id" uuid,
	"reason" text NOT NULL,
	"filed_by" uuid,
	"filed_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"grade_at_resolution_id" uuid
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contestation_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contestation_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_grade_at_filing_id_project_criterion_grades_id_fk" FOREIGN KEY ("grade_at_filing_id") REFERENCES "public"."project_criterion_grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_filed_by_users_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_grade_at_resolution_id_project_criterion_grades_id_fk" FOREIGN KEY ("grade_at_resolution_id") REFERENCES "public"."project_criterion_grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_contestations_criterion_uq" ON "project_contestations" USING btree ("repo_id","criterion_id");--> statement-breakpoint
CREATE INDEX "project_contestations_open_idx" ON "project_contestations" USING btree ("repo_id") WHERE "project_contestations"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_project_contestation_filed_fold_uq" ON "notifications" USING btree ("user_id","project_id") WHERE "notifications"."payload"->>'kind' = 'project_contestation_filed' and "notifications"."read_at" is null;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_contestation_days_range" CHECK ("projects"."contestation_days" between 0 and 60);--> statement-breakpoint
-- ADR-139 §13, decision 8: a project graded by criteria released before
-- contestations shipped gets the window of its FIRST release, seven days
-- (the default: no project chose a window yet). `released_at` is rewritten
-- by every release: the first is the earliest `project.release` audit row of
-- the project, `released_at` only when none was kept. One already past is
-- simply closed.
UPDATE "projects" SET "contestation_closes_at" = coalesce(
  (SELECT min("audit_log"."created_at") FROM "audit_log"
    WHERE "audit_log"."subject_type" = 'project' AND "audit_log"."subject_id" = "projects"."id"::text
      AND "audit_log"."action" = 'project.release'),
  "projects"."released_at"
) + interval '7 days'
WHERE "projects"."grading_mode" = 'criteria' AND "projects"."released_at" IS NOT NULL;
