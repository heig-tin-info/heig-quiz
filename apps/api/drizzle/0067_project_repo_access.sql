CREATE TABLE "project_repo_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_repo_access" ADD CONSTRAINT "project_repo_access_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repo_access" ADD CONSTRAINT "project_repo_access_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_repo_access_repo_enrollment_account_uq" ON "project_repo_access" USING btree ("repo_id","enrollment_id","github_user_id");--> statement-breakpoint
CREATE INDEX "project_repo_access_live_idx" ON "project_repo_access" USING btree ("enrollment_id") WHERE "project_repo_access"."revoked_at" IS NULL;--> statement-breakpoint
-- The invited accounts of the individual repositories M3-03 provisioned
-- before this table: the student's link of today stands for the account
-- invited at Accept (the best this database knows), on their student seat
-- of the project's classroom, so a departure revokes it (F-PROJ-17). A
-- student who unlinked since has none: their removal says `not_invited`.
INSERT INTO "project_repo_access" ("id", "repo_id", "enrollment_id", "github_user_id", "github_login", "invited_at")
SELECT gen_random_uuid(), r."id", e."id", a."github_user_id", a."login", r."accepted_at"
FROM "project_repos" r
JOIN "projects" p ON p."id" = r."project_id"
JOIN "enrollments" e ON e."classroom_id" = p."classroom_id" AND e."user_id" = r."user_id" AND e."staff" = false
JOIN "github_accounts" a ON a."user_id" = r."user_id"
WHERE r."group_id" IS NULL AND r."provision_status" = 'ok' AND r."invitation_status" <> 'none'
ON CONFLICT DO NOTHING;
