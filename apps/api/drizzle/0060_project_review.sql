ALTER TABLE "projects" DROP COLUMN "review_dispatched_at";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "dispatch_job_at" timestamp with time zone;
