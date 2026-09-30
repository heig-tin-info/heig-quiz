ALTER TABLE "evaluations" ADD COLUMN "grading_ready_at" timestamp with time zone;--> statement-breakpoint
-- An evaluation closed before this column existed counts as announced, so a pass run on it
-- again does not tell the staff a second time (#286). Accepted cost: one whose grid was still
-- incomplete at the deploy (runner jobs in flight, or a legacy in_progress attempt left open
-- after the close, #95) will not be announced when it completes.
UPDATE "evaluations" SET "grading_ready_at" = "closed_at" WHERE "closed_at" IS NOT NULL AND "state" IN ('closed', 'grading', 'released');
