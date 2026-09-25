ALTER TABLE "answers" ADD COLUMN "skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;