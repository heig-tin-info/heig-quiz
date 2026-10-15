ALTER TABLE "api_tokens" ADD COLUMN "scope" text;--> statement-breakpoint
-- ADR-113 §6: every personal token issued before the scopes keeps the reach
-- it had, the whole API, written explicitly. Personal tokens only: an OAuth
-- access token (grant_id, audience) or a help-assistant token (audience) is
-- never touched, and stays without a scope.
UPDATE "api_tokens" SET "scope" = 'api' WHERE "audience" IS NULL AND "grant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scope_ck" CHECK ("api_tokens"."scope" in ('quiz', 'quiz:read', 'api'));--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scope_personal_ck" CHECK (("api_tokens"."audience" is null) = ("api_tokens"."scope" is not null));
