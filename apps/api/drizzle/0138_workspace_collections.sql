CREATE TABLE "codespace_collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"reason" text,
	"branch" text,
	"sha" text,
	"unreadable" integer,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "push_receipts" ADD COLUMN "collected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "codespace_collections" ADD CONSTRAINT "codespace_collections_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "codespace_collections_repo_deadline_uq" ON "codespace_collections" USING btree ("repo_id","deadline_at");