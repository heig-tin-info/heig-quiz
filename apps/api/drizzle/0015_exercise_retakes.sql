-- F-EVAL-15, ADR-025 (#92): several attempts on an exercise.
-- Every existing row becomes attempt number 1 through the column default:
-- the old index guaranteed at most one row per (evaluation, user), so the
-- two new indexes hold on existing data by construction.
ALTER TABLE "attempts" ADD COLUMN "attempt_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_evaluation_user_number_uq" ON "attempts" USING btree ("evaluation_id","user_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_evaluation_user_open_uq" ON "attempts" USING btree ("evaluation_id","user_id") WHERE "attempts"."state" in ('not_started', 'in_progress');--> statement-breakpoint
DROP INDEX "attempts_evaluation_user_uq";
