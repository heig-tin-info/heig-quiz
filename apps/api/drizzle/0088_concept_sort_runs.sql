CREATE TABLE "concept_sort_runs" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"state" text NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"groups_done" integer DEFAULT 0 NOT NULL,
	"groups_total" integer DEFAULT 0 NOT NULL,
	"batches_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "concept_sort_runs_singleton" CHECK ("concept_sort_runs"."id" = 'default'),
	CONSTRAINT "concept_sort_runs_finished_ck" CHECK (("concept_sort_runs"."state" = 'running') = ("concept_sort_runs"."finished_at" is null)),
	CONSTRAINT "concept_sort_runs_error_ck" CHECK (("concept_sort_runs"."state" = 'failed') = ("concept_sort_runs"."error" is not null))
);
--> statement-breakpoint
ALTER TABLE "concept_sort_runs" ADD CONSTRAINT "concept_sort_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;