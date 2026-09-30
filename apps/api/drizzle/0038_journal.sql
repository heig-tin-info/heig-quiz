CREATE TABLE "classroom_journals" (
	"classroom_id" uuid PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"ref" text NOT NULL,
	"root_path" text DEFAULT '' NOT NULL,
	"last_commit_sha" text,
	"last_synced_at" timestamp with time zone,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classroom_journals_sync_status_ck" CHECK ("classroom_journals"."sync_status" IN ('pending', 'ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "journal_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_assets_size_ck" CHECK ("journal_assets"."size" BETWEEN 0 AND 5000000)
);
--> statement-breakpoint
CREATE TABLE "journal_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"path" text NOT NULL,
	"parent_path" text NOT NULL,
	"sort_key" text NOT NULL,
	"title" text NOT NULL,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob_sha" text NOT NULL,
	"markdown" text NOT NULL,
	"html" text NOT NULL,
	"toc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"visible_from" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_assets" ADD CONSTRAINT "journal_assets_classroom_id_classroom_journals_classroom_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classroom_journals"("classroom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_pages" ADD CONSTRAINT "journal_pages_classroom_id_classroom_journals_classroom_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classroom_journals"("classroom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classroom_journals_repo_idx" ON "classroom_journals" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_assets_classroom_path_uq" ON "journal_assets" USING btree ("classroom_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_pages_classroom_path_uq" ON "journal_pages" USING btree ("classroom_id","path");--> statement-breakpoint
CREATE INDEX "journal_pages_visible_from_idx" ON "journal_pages" USING btree ("visible_from") WHERE "journal_pages"."visible_from" IS NOT NULL;