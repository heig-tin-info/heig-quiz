CREATE TABLE "course_concepts" (
	"course_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_concepts_course_id_concept_id_pk" PRIMARY KEY("course_id","concept_id")
);
--> statement-breakpoint
ALTER TABLE "course_concepts" ADD CONSTRAINT "course_concepts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_concepts" ADD CONSTRAINT "course_concepts_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_concepts" ADD CONSTRAINT "course_concepts_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_concepts_concept_idx" ON "course_concepts" USING btree ("concept_id");