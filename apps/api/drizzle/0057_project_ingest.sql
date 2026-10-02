ALTER TABLE "project_grade_runs" ADD COLUMN "parse_detail" text;--> statement-breakpoint
ALTER TABLE "project_grade_runs" ADD COLUMN "to_verify" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reverts" ADD COLUMN "head_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "reverts_repo_head_uq" ON "reverts" USING btree ("repo_id","head_sha") WHERE "reverts"."head_sha" IS NOT NULL;