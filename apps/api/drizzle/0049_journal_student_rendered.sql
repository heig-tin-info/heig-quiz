ALTER TABLE "classroom_journals" ADD COLUMN "student_rendered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;