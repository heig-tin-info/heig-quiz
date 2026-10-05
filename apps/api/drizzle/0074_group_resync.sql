ALTER TABLE "projects" ADD COLUMN "group_resync" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_resync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_resync_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_group_resync_by_users_id_fk" FOREIGN KEY ("group_resync_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;