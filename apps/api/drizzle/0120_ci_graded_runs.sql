CREATE TABLE "project_ci_results" (
	"pass_id" uuid PRIMARY KEY NOT NULL,
	"workflow_run_id" bigint NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "grade_dispatches_repo_trigger_uq";--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_ci_results" ADD CONSTRAINT "project_ci_results_pass_id_grade_dispatches_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."grade_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_dispatches_nonce_uq" ON "grade_dispatches" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "grade_dispatches_ci_waiting_idx" ON "grade_dispatches" USING btree ("created_at") WHERE "grade_dispatches"."nonce" IS NOT NULL AND "grade_dispatches"."closed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_dispatches_repo_trigger_uq" ON "grade_dispatches" USING btree ("repo_id","trigger",coalesce("checkpoint_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "grade_dispatches"."trigger" <> 'regrade';--> statement-breakpoint
-- ADR-119 §11: a snapshot stored before schema 3 is schema 2; the version is the discriminator of the grading path.
UPDATE "project_criteria" SET "criteria" = jsonb_set("criteria", '{schemaVersion}', '2'::jsonb) WHERE "criteria"->'schemaVersion' IS NULL;
