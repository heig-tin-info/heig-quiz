CREATE TABLE "group_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"name" text NOT NULL,
	"max_size" integer,
	"open_until" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "student_groups_id_set_uq" UNIQUE("id","set_id")
);
--> statement-breakpoint
ALTER TABLE "project_groups" ADD COLUMN "source_group_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_set_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "groups_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_sets" ADD CONSTRAINT "group_sets_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_sets" ADD CONSTRAINT "group_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_set_id_group_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."group_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_group_set_fk" FOREIGN KEY ("group_id","set_id") REFERENCES "public"."student_groups"("id","set_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_groups" ADD CONSTRAINT "student_groups_set_id_group_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."group_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_sets_classroom_idx" ON "group_sets" USING btree ("classroom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_group_members_set_enrollment_uq" ON "student_group_members" USING btree ("set_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "student_group_members_group_idx" ON "student_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "student_group_members_enrollment_idx" ON "student_group_members" USING btree ("enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_groups_set_name_uq" ON "student_groups" USING btree ("set_id","name");--> statement-breakpoint
ALTER TABLE "project_groups" ADD CONSTRAINT "project_groups_source_group_id_student_groups_id_fk" FOREIGN KEY ("source_group_id") REFERENCES "public"."student_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_group_set_id_group_sets_id_fk" FOREIGN KEY ("group_set_id") REFERENCES "public"."group_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_groups_source_idx" ON "project_groups" USING btree ("source_group_id");--> statement-breakpoint
CREATE INDEX "projects_group_set_idx" ON "projects" USING btree ("group_set_id");--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "group_max_size";