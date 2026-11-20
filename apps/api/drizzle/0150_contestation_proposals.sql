ALTER TABLE "api_tokens" ADD COLUMN "consent_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "consent_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD COLUMN "consent_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_verdict" text;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_reply" text;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_points" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_acceptance" jsonb;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_by" uuid;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contestations" ADD COLUMN "grading_at_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_verdict" text;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_reply" text;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_points" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_rationale" text;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_by" uuid;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD COLUMN "grade_at_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_grading_at_proposal_id_gradings_id_fk" FOREIGN KEY ("grading_at_proposal_id") REFERENCES "public"."gradings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_grade_at_proposal_id_project_criterion_grades_id_fk" FOREIGN KEY ("grade_at_proposal_id") REFERENCES "public"."project_criterion_grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contestations" ADD CONSTRAINT "contestations_proposal_ck" CHECK (("contestations"."proposed_at" is null) = ("contestations"."proposed_verdict" is null));--> statement-breakpoint
ALTER TABLE "project_contestations" ADD CONSTRAINT "project_contestations_proposal_ck" CHECK (("project_contestations"."proposed_at" is null) = ("project_contestations"."proposed_verdict" is null));