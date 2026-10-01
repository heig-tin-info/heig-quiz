ALTER TABLE "question_versions" ADD COLUMN "variables" jsonb;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "instances" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD COLUMN "serve_values" jsonb;--> statement-breakpoint
ALTER TABLE "drill_reviews" ADD COLUMN "values" jsonb;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD CONSTRAINT "drill_cards_serve_values_ck" CHECK ("drill_cards"."serve_seed" is not null or "drill_cards"."serve_values" is null);--> statement-breakpoint
-- Hand-written (ADR-056 §1): `randomizable` is now derived from the latest
-- published version, which has no variables before this migration. Until
-- now a QuestionPatch (or MCP) could set it on a static question.
UPDATE "questions" SET "randomizable" = false;
