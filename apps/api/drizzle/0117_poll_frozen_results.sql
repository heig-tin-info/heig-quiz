CREATE TABLE "poll_frozen_results" (
	"evaluation_id" uuid PRIMARY KEY NOT NULL,
	"joined" integer NOT NULL,
	"payloads" jsonb NOT NULL,
	"correct" integer,
	"frozen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poll_frozen_results" ADD CONSTRAINT "poll_frozen_results_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;