ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_kind" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_value" double precision;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_base" double precision;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_comment" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjusted_by" uuid;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "released_adjustment_comment" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_grade_adjusted_by_users_id_fk" FOREIGN KEY ("grade_adjusted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_grade_adjust_whole" CHECK (num_nonnulls("project_repos"."grade_adjust_kind", "project_repos"."grade_adjust_value", "project_repos"."grade_adjust_base", "project_repos"."grade_adjust_comment", "project_repos"."grade_adjusted_by", "project_repos"."grade_adjusted_at") IN (0, 6));