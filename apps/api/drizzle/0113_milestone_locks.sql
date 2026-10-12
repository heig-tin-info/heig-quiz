ALTER TABLE "project_criterion_grades" ADD COLUMN "locked_by_checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "project_criterion_grades" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
-- DEFERRABLE INITIALLY DEFERRED is written by hand (ADR-106 §5; drizzle cannot express it): a project's
-- deletion cascades through its checkpoints and these rows in one transaction, while a checkpoint that
-- locked rows is never deleted alone.
ALTER TABLE "project_criterion_grades" ADD CONSTRAINT "project_criterion_grades_locked_by_checkpoint_id_project_checkpoints_id_fk" FOREIGN KEY ("locked_by_checkpoint_id") REFERENCES "public"."project_checkpoints"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
