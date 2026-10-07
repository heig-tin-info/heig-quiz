CREATE TABLE "codespace_projects" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"synced_at" timestamp with time zone,
	"sync_error" text,
	"first_launch_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD COLUMN "codespace_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD COLUMN "codespace_max_active_sessions" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "work_mode" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "codespace_projects" ADD CONSTRAINT "codespace_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;