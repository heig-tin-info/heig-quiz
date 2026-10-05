CREATE TABLE "project_sync_prs" (
	"repo_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"pr_number" integer NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_sync_prs_repo_id_branch_pk" PRIMARY KEY("repo_id","branch")
);
--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "sync_outcome" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "sync_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_ahead" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_heads" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sync_job_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_sync_prs" ADD CONSTRAINT "project_sync_prs_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- The sync pull request heig-classroom kept per repository (one, for the
-- default branch) becomes that branch's row (F-PROJ-12, one per branch).
INSERT INTO "project_sync_prs" ("repo_id", "branch", "pr_number", "state", "updated_at")
SELECT r."id", coalesce(r."default_branch", p."branches"[1]), r."sync_pr_number", r."sync_pr_state", now()
FROM "project_repos" r
JOIN "projects" p ON p."id" = r."project_id"
WHERE r."sync_pr_number" IS NOT NULL AND r."sync_pr_state" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "project_repos" DROP COLUMN "sync_pr_number";--> statement-breakpoint
ALTER TABLE "project_repos" DROP COLUMN "sync_pr_state";
