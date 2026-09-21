ALTER TABLE "users" ADD COLUMN "mcq_policy" text;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "mcq_policy" text DEFAULT 'all_or_nothing' NOT NULL;