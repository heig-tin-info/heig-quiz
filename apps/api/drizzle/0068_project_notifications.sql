ALTER TABLE "notifications" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "github_organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_project_idx" ON "notifications" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_project_deadline_applied_fold_uq" ON "notifications" USING btree ("user_id","project_id") WHERE "notifications"."payload"->>'kind' = 'project_deadline_applied' and "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_project_provision_failed_fold_uq" ON "notifications" USING btree ("user_id","project_id") WHERE "notifications"."payload"->>'kind' = 'project_provision_failed' and "notifications"."read_at" is null;