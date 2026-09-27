ALTER TABLE "evaluations" DROP CONSTRAINT "evaluations_home_ck";--> statement-breakpoint
DROP INDEX "evaluations_owned_poll_idx";--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "origin_template_id" uuid;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "origin_revision" integer;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_origin_template_id_evaluations_id_fk" FOREIGN KEY ("origin_template_id") REFERENCES "public"."evaluations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluations_template_idx" ON "evaluations" USING btree ("course_id","created_at") WHERE "evaluations"."course_id" is not null;--> statement-breakpoint
CREATE INDEX "evaluations_owned_poll_idx" ON "evaluations" USING btree ("created_by","created_at") WHERE ("evaluations"."classroom_id" is null and "evaluations"."course_id" is null and "evaluations"."mode" = 'poll');--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_template_ck" CHECK ("evaluations"."course_id" is null or ("evaluations"."opens_at" is null and "evaluations"."closes_at" is null and "evaluations"."access_code" is null and cardinality("evaluations"."ip_allowlist") = 0 and "evaluations"."state" = 'draft' and "evaluations"."mode" <> 'poll' and "evaluations"."revision" is not null and "evaluations"."origin_template_id" is null));--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_home_ck" CHECK (("evaluations"."classroom_id" is not null and "evaluations"."course_id" is null) or ("evaluations"."classroom_id" is null and "evaluations"."course_id" is not null) or ("evaluations"."classroom_id" is null and "evaluations"."course_id" is null and "evaluations"."mode" = 'poll' and "evaluations"."created_by" is not null));