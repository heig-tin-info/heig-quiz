ALTER TABLE "launch_tickets" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "codespace_projects" ADD COLUMN "browser_exam_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_tickets" ADD CONSTRAINT "launch_tickets_one_activity" CHECK ("launch_tickets"."evaluation_id" IS NULL OR "launch_tickets"."project_id" IS NULL);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_one_activity" CHECK ("sessions"."evaluation_id" IS NULL OR "sessions"."project_id" IS NULL);