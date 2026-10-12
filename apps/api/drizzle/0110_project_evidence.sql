CREATE TABLE "project_criterion_grades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"max" numeric(6, 2) NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"rationale" text,
	"reason" text,
	"pass_id" uuid,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "project_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"target_sha" text,
	"distribution_sha" text,
	"status" text NOT NULL,
	"reason" text,
	"build" jsonb,
	"test" jsonb,
	"cases" jsonb,
	"files" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_evidence_repo_shas_uq" UNIQUE NULLS NOT DISTINCT("repo_id","target_sha","distribution_sha")
);
--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_supersedes_id_project_criterion_grades_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."project_criterion_grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_criterion_grades_validated_uq" ON "project_criterion_grades" USING btree ("repo_id","criterion_id") WHERE "project_criterion_grades"."state" = 'validated';--> statement-breakpoint
CREATE INDEX "project_criterion_grades_repo_idx" ON "project_criterion_grades" USING btree ("repo_id","criterion_id");