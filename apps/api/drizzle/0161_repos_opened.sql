ALTER TABLE "projects" ADD COLUMN "repos_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repos_access_job_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repos_access_rev" integer DEFAULT 0 NOT NULL;