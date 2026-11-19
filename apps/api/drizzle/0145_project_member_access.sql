ALTER TABLE "project_repo_access" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repo_access" ADD COLUMN "absent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repo_access" ADD COLUMN "reinvited_at" timestamp with time zone;--> statement-breakpoint
-- ADR-070's amendment of 2026-11-19: a student's own repository whose row says accepted has its live grants joined; a group's are checked by the daily reconciliation, pending until then.
UPDATE "project_repo_access" AS a SET "accepted_at" = now()
  FROM "project_repos" AS r
  WHERE a."repo_id" = r."id" AND r."group_id" IS NULL AND r."invitation_status" = 'accepted' AND a."revoked_at" IS NULL;--> statement-breakpoint
-- The day's re-invite claim moves from the row to the grant: an individual repository's day carries over.
UPDATE "project_repo_access" AS a SET "reinvited_at" = r."invitation_reinvited_at"
  FROM "project_repos" AS r
  WHERE a."repo_id" = r."id" AND r."group_id" IS NULL AND r."invitation_reinvited_at" IS NOT NULL AND a."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "project_repos" DROP COLUMN "invitation_reinvited_at";
