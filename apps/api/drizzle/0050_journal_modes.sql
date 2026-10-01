CREATE TABLE "journal_page_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"path" text NOT NULL,
	"markdown" text NOT NULL,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_journals" ALTER COLUMN "github_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_journals" ALTER COLUMN "full_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_journals" ALTER COLUMN "ref" DROP NOT NULL;--> statement-breakpoint
-- Every journal so far mirrors a repository: the existing rows become GitHub mode (ADR-057).
ALTER TABLE "classroom_journals" ADD COLUMN "mode" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
-- No default afterwards: every insertion names its mode.
ALTER TABLE "classroom_journals" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "journal_pages" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_page_revisions" ADD CONSTRAINT "journal_page_revisions_classroom_id_classroom_journals_classroom_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classroom_journals"("classroom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_page_revisions" ADD CONSTRAINT "journal_page_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_page_revisions_page_idx" ON "journal_page_revisions" USING btree ("classroom_id","path","created_at");--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_mode_ck" CHECK (("classroom_journals"."mode" = 'github' AND "classroom_journals"."github_repo_id" IS NOT NULL AND "classroom_journals"."full_name" IS NOT NULL AND "classroom_journals"."ref" IS NOT NULL)
        OR ("classroom_journals"."mode" = 'quiz' AND "classroom_journals"."github_repo_id" IS NULL AND "classroom_journals"."full_name" IS NULL AND "classroom_journals"."ref" IS NULL));