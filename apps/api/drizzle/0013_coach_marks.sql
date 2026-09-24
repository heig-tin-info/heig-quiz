ALTER TABLE "users" ADD COLUMN "coach_enabled" boolean;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "coach_seen" jsonb DEFAULT '[]'::jsonb NOT NULL;