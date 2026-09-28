-- ADR-030, amended 2026-09-28: Teams notifications go to the activity feed
-- through Microsoft Graph; a link is keyed on the Entra identity, no chat.
-- A pending link token names a chat and lives fifteen minutes: none survives.
DELETE FROM "teams_link_tokens";--> statement-breakpoint
-- One Quiz account per Teams account from now on: should two accounts hold
-- the same Teams account, the most recent link stays.
DELETE FROM "teams_links" AS "older" USING "teams_links" AS "newer" WHERE "older"."tenant_id" = "newer"."tenant_id" AND "older"."aad_object_id" = "newer"."aad_object_id" AND ("older"."linked_at", "older"."user_id") < ("newer"."linked_at", "newer"."user_id");--> statement-breakpoint
DROP INDEX "teams_link_tokens_conversation_idx";--> statement-breakpoint
DROP INDEX "teams_links_conversation_idx";--> statement-breakpoint
ALTER TABLE "teams_link_tokens" ADD COLUMN "teams_username" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams_links" ADD COLUMN "teams_username" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "teams_link_tokens_identity_idx" ON "teams_link_tokens" USING btree ("tenant_id","aad_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_links_identity_idx" ON "teams_links" USING btree ("tenant_id","aad_object_id");--> statement-breakpoint
ALTER TABLE "teams_link_tokens" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "teams_link_tokens" DROP COLUMN "service_url";--> statement-breakpoint
ALTER TABLE "teams_links" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "teams_links" DROP COLUMN "service_url";
