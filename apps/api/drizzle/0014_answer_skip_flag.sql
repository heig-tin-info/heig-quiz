ALTER TABLE "answers" ADD COLUMN "skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Issue #89 changes what `marked_done` means. It used to be the student's
-- "Mark as done", offered in every navigation; it now means VALIDATED, the
-- irreversible step of `forward_only` ("Validate and continue") and of a
-- crossed checkpoint in `milestones`. In a `free` evaluation nothing is ever
-- validated, so a `true` left over from the old button would now read
-- "Validated" on the grid and in the player. Those rows are reset. Rows of
-- `forward_only` and `milestones` evaluations keep their value: there the old
-- "done" and the new "validated" are the same fact (it locked the question).
UPDATE "answers" SET "marked_done" = false
FROM "attempts", "evaluations"
WHERE "answers"."attempt_id" = "attempts"."id"
  AND "attempts"."evaluation_id" = "evaluations"."id"
  AND "answers"."marked_done" = true
  AND coalesce("evaluations"."settings"->>'navigation', 'free') = 'free';
