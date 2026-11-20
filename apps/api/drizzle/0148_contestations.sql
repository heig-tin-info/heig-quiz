CREATE TABLE "contestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"filed_by" uuid,
	"filed_at" timestamp with time zone NOT NULL,
	"grading_at_filing_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"grading_at_resolution_id" uuid
);
--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "contestation_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_item_id_evaluation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."evaluation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_filed_by_users_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_grading_at_filing_id_gradings_id_fk" FOREIGN KEY ("grading_at_filing_id") REFERENCES "public"."gradings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_grading_at_resolution_id_gradings_id_fk" FOREIGN KEY ("grading_at_resolution_id") REFERENCES "public"."gradings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contestations_cell_uq" ON "contestations" USING btree ("attempt_id","item_id");--> statement-breakpoint
CREATE INDEX "contestations_open_idx" ON "contestations" USING btree ("item_id") WHERE "contestations"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_contestation_filed_fold_uq" ON "notifications" USING btree ("user_id","evaluation_id") WHERE "notifications"."payload"->>'kind' = 'contestation_filed' and "notifications"."read_at" is null;--> statement-breakpoint
-- ADR-139, decision 11: an exam released before contestations shipped gets
-- the window of its release, seven days (the default; no policy stored a
-- window yet), where its feedback policy shows results. One already past is
-- simply closed: its instant lies behind the database's clock.
UPDATE "evaluations" SET "contestation_closes_at" = "released_at" + interval '7 days'
WHERE "mode" = 'exam' AND "released_at" IS NOT NULL AND coalesce("feedback_policy"->>'when', 'on_release') <> 'none';
