CREATE TABLE "project_criteria" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"file_sha" text NOT NULL,
	"source_sha" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"loaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tests_criterion" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "build_command" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "test_command" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "evidence_outputs" jsonb;--> statement-breakpoint
ALTER TABLE "project_criteria" ADD CONSTRAINT "project_criteria_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;