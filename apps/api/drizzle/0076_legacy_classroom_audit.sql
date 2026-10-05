CREATE TABLE "legacy_classroom_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" bigint NOT NULL,
	"actor_user_id" uuid,
	"source_actor_user_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_classroom_audit_log_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
ALTER TABLE "import_classroom"."id_map" ADD COLUMN "target_table" text;--> statement-breakpoint
ALTER TABLE "import_classroom"."id_map" ADD COLUMN "imported_hash" text;--> statement-breakpoint
ALTER TABLE "import_classroom"."id_map" ADD COLUMN "source_hash" text;--> statement-breakpoint
CREATE INDEX "legacy_classroom_audit_subject_idx" ON "legacy_classroom_audit_log" USING btree ("subject_type","subject_id");