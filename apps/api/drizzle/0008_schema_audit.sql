-- The database wave of the 2026-09-22 audit (docs/audit-2026-09-22/database.md).
-- Production holds data: every statement below is safe on a non-empty table,
-- and the whole file runs in the migrator's single transaction.
--
-- D-04: three phase-2 tables nothing reads or writes. No CASCADE: nothing
-- references them, and a drop that would take something else along must fail.
DROP TABLE "api_tokens";--> statement-breakpoint
DROP TABLE "answer_flags";--> statement-breakpoint
DROP TABLE "llm_calls";--> statement-breakpoint
-- D-10: deleting an account never erases its attempts in passing.
ALTER TABLE "attempts" DROP CONSTRAINT "attempts_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- D-11: three indexes that are prefixes of unique ones.
DROP INDEX "question_versions_question_idx";--> statement-breakpoint
DROP INDEX "answers_attempt_idx";--> statement-breakpoint
DROP INDEX "attempts_evaluation_idx";--> statement-breakpoint
-- D-07: the notification -> pool relation becomes a foreign key. Add the
-- column, backfill it from the payload, then constrain it. A row whose pool
-- is already gone was hidden from the bell (list and unread) by the old
-- LEFT JOIN; it cannot hold a dangling key, so it goes, as deletePool would
-- have removed it.
ALTER TABLE "notifications" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
UPDATE "notifications" SET "pool_id" = "pools"."id" FROM "pools" WHERE "pools"."id"::text = "notifications"."payload" ->> 'poolId';--> statement-breakpoint
DELETE FROM "notifications" WHERE "payload" ->> 'poolId' IS NOT NULL AND "pool_id" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_pool_idx" ON "notifications" USING btree ("pool_id");--> statement-breakpoint
-- D-03: the poll session code, indexed for the QR scan and unique among the
-- running polls.
CREATE INDEX "evaluations_access_code_idx" ON "evaluations" USING btree ("access_code") WHERE "evaluations"."access_code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_running_poll_code_uq" ON "evaluations" USING btree ("access_code") WHERE "evaluations"."mode" = 'poll' and "evaluations"."state" = 'running';--> statement-breakpoint
-- D-09: user_id IS NULL is the claim status. Every write set both columns;
-- should a 'pending' row still hold an account, it is detached first so that
-- it stays exactly as (un)claimed as it was.
UPDATE "enrollments" SET "user_id" = NULL, "claimed_at" = NULL WHERE "status" = 'pending' AND "user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" DROP COLUMN "status";
