-- ADR-039: the time a question is on screen, measured by the server.
-- `display_tracked` is added with default FALSE, so every attempt that exists
-- today reads "never reported what was on screen", then the default becomes
-- TRUE for every attempt created from now on (hand-edited: drizzle-kit
-- generates the second default only).
ALTER TABLE "answers" ADD COLUMN "first_shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "dwell_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "shown_item_id" uuid;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "shown_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "display_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ALTER COLUMN "display_tracked" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_shown_ck" CHECK (("attempts"."shown_item_id" is null) = ("attempts"."shown_since" is null));