DROP INDEX "projects_freeze_due_idx";--> statement-breakpoint
DROP INDEX "projects_review_due_idx";--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "deadline_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "deadline_committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "staff_lock" boolean;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "frozen_at";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deadline_job_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "project_repos_freeze_due_idx" ON "project_repos" USING btree ("project_id") WHERE "project_repos"."deadline_applied_at" IS NOT NULL AND "project_repos"."frozen_at" IS NULL;
