ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_kind" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_value" double precision;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_base" double precision;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjust_comment" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjusted_by" uuid;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "grade_adjusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "released_adjustment_comment" text;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_grade_adjusted_by_users_id_fk" FOREIGN KEY ("grade_adjusted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;