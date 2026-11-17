ALTER TABLE "grade_dispatches" ADD COLUMN "graded_sha" text;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD COLUMN "distribution_sha" text;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD COLUMN "grafted_paths" text[];