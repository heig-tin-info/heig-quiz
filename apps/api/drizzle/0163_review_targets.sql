-- ADR-147 §4: a review's row lives 15 minutes; the rows in flight are dropped rather than given a project and an id.
DELETE FROM "codespace_reviews";--> statement-breakpoint
ALTER TABLE "codespace_reviews" DROP CONSTRAINT "codespace_reviews_user_id_project_repo_id_pk";--> statement-breakpoint
ALTER TABLE "codespace_reviews" ALTER COLUMN "project_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD COLUMN "id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD CONSTRAINT "codespace_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codespace_reviews_project_idx" ON "codespace_reviews" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD CONSTRAINT "codespace_reviews_target_uq" UNIQUE NULLS NOT DISTINCT("user_id","project_id","project_repo_id");