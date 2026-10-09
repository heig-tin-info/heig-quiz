CREATE TABLE "changelog_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"first_live_at" timestamp with time zone DEFAULT now() NOT NULL,
	"commit_sha" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "changelog_seen_at" timestamp with time zone DEFAULT now() NOT NULL;