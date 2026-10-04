CREATE TABLE "poll_ai_runs" (
	"evaluation_id" uuid PRIMARY KEY NOT NULL,
	"lease_at" timestamp with time zone,
	"calls" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poll_idea_marks" ADD COLUMN "correction" text;--> statement-breakpoint
ALTER TABLE "poll_idea_marks" ADD COLUMN "source" text DEFAULT 'teacher' NOT NULL;--> statement-breakpoint
ALTER TABLE "poll_ai_runs" ADD CONSTRAINT "poll_ai_runs_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_idea_marks" ADD CONSTRAINT "poll_idea_marks_source_ck" CHECK ("poll_idea_marks"."source" IN ('teacher', 'ai'));