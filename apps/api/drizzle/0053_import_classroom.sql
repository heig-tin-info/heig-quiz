CREATE SCHEMA "import_classroom";
--> statement-breakpoint
CREATE TABLE "import_classroom"."id_map" (
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"how" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "id_map_source_table_source_id_pk" PRIMARY KEY("source_table","source_id")
);
--> statement-breakpoint
CREATE TABLE "import_classroom"."runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"mapping_sha256" text NOT NULL,
	"options" jsonb NOT NULL,
	"report" jsonb NOT NULL
);
