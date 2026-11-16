CREATE TABLE "gradebook_components" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gradebook_components_weight_range" CHECK ("gradebook_components"."weight" >= 0 AND "gradebook_components"."weight" <= 100)
);
--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD COLUMN "component_id" uuid;--> statement-breakpoint
ALTER TABLE "gradebook_components" ADD CONSTRAINT "gradebook_components_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradebook_components" ADD CONSTRAINT "gradebook_components_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gradebook_components_course_name_uq" ON "gradebook_components" USING btree ("course_id",lower("name"));--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_component_id_gradebook_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."gradebook_components"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gradebook_columns_component_idx" ON "gradebook_columns" USING btree ("component_id");