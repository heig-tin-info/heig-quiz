ALTER TABLE "project_repos" ADD COLUMN "invitation_resent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "teacher_max" double precision;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "protection_reenabled_at" timestamp with time zone;