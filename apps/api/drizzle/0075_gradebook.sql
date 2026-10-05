CREATE TABLE "gradebook_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"evaluation_id" uuid,
	"project_id" uuid,
	"weight" numeric(3, 1) NOT NULL,
	"counts" boolean NOT NULL,
	"position" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gradebook_columns_id_classroom_uq" UNIQUE("id","classroom_id"),
	CONSTRAINT "gradebook_columns_one_activity" CHECK (("gradebook_columns"."evaluation_id" IS NULL) <> ("gradebook_columns"."project_id" IS NULL)),
	CONSTRAINT "gradebook_columns_weight_range" CHECK ("gradebook_columns"."weight" >= 0 AND "gradebook_columns"."weight" <= 10)
);
--> statement-breakpoint
CREATE TABLE "gradebook_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" numeric(8, 2),
	"max" numeric(8, 2),
	"comment" text,
	"set_by" uuid,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gradebook_marks_column_enrollment_uq" UNIQUE("column_id","enrollment_id"),
	CONSTRAINT "gradebook_marks_shape" CHECK (("gradebook_marks"."kind" = 'absent' AND "gradebook_marks"."points" IS NULL AND "gradebook_marks"."max" IS NULL)
        OR ("gradebook_marks"."kind" = 'score' AND "gradebook_marks"."points" IS NOT NULL AND "gradebook_marks"."max" IS NOT NULL AND "gradebook_marks"."max" > 0 AND "gradebook_marks"."points" >= 0 AND "gradebook_marks"."points" <= "gradebook_marks"."max"))
);
--> statement-breakpoint
CREATE TABLE "gradebook_settings" (
	"classroom_id" uuid PRIMARY KEY NOT NULL,
	"mean_published" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_marks" ADD CONSTRAINT "gradebook_marks_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_marks" ADD CONSTRAINT "gradebook_marks_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_marks" ADD CONSTRAINT "gradebook_marks_column_classroom_fk" FOREIGN KEY ("column_id","classroom_id") REFERENCES "public"."gradebook_columns"("id","classroom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_settings" ADD CONSTRAINT "gradebook_settings_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_settings" ADD CONSTRAINT "gradebook_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gradebook_columns_evaluation_uq" ON "gradebook_columns" USING btree ("evaluation_id") WHERE "gradebook_columns"."evaluation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gradebook_columns_project_uq" ON "gradebook_columns" USING btree ("project_id") WHERE "gradebook_columns"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gradebook_columns_classroom_idx" ON "gradebook_columns" USING btree ("classroom_id");--> statement-breakpoint
CREATE INDEX "gradebook_marks_enrollment_idx" ON "gradebook_marks" USING btree ("enrollment_id");