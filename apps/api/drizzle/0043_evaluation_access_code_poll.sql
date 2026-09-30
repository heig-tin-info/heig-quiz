-- ADR-053: an exam or an exercise has no access code any more; `access_code` is a
-- poll's session code (ADR-014) and nothing else. Clear any code left on a non-poll
-- row first (production had none when this was written), then let the database
-- refuse one from now on.
UPDATE "evaluations" SET "access_code" = NULL WHERE "mode" <> 'poll';--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_access_code_poll_ck" CHECK ("evaluations"."access_code" is null or "evaluations"."mode" = 'poll');
