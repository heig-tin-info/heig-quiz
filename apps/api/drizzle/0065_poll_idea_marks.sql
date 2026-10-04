CREATE TABLE "poll_idea_marks" (
	"evaluation_id" uuid NOT NULL,
	"idea_key" text NOT NULL,
	"status" text,
	"merged_into" text,
	"label" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_idea_marks_evaluation_id_idea_key_pk" PRIMARY KEY("evaluation_id","idea_key"),
	CONSTRAINT "poll_idea_marks_status_ck" CHECK ("poll_idea_marks"."status" IN ('approved', 'hidden'))
);
--> statement-breakpoint
ALTER TABLE "poll_idea_marks" ADD CONSTRAINT "poll_idea_marks_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;