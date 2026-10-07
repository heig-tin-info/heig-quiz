CREATE TABLE "course_conditions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_conditions_text_ck" CHECK (char_length("course_conditions"."text") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "course_conditions" ADD CONSTRAINT "course_conditions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_conditions_course_idx" ON "course_conditions" USING btree ("course_id","position");