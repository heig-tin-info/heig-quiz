DROP INDEX "projects_scheduled_publish_idx";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "scheduled_announced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "projects_scheduled_publish_idx" ON "projects" USING btree ("start_at") WHERE "projects"."state" = 'scheduled' AND "projects"."archived_at" IS NULL;--> statement-breakpoint
-- ADR-127 §5: a draft is no longer armed by itself. Every draft the ticker
-- would have published (a date, a built distribution, a deadline ahead)
-- becomes `scheduled`, archived ones included (hidden by `archived_at`,
-- re-armed by an unarchive as before). Nobody is told: the marker stays null.
UPDATE "projects" SET "state" = 'scheduled' WHERE "state" = 'draft' AND "publish_mode" = 'scheduled' AND "distribution_full_name" IS NOT NULL AND "deadline_at" > now();
