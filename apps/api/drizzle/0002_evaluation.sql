CREATE TABLE "evaluation_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question_version_id" uuid NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"milestone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"title" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"settings" jsonb NOT NULL,
	"grading_scale" jsonb NOT NULL,
	"feedback_policy" jsonb NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"duration_s" integer,
	"access_code" text,
	"ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_grades" jsonb,
	"modified_after_release" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"marked_done" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'not_started' NOT NULL,
	"seed" integer NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"bonus_s" integer DEFAULT 0 NOT NULL,
	"extra_s" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"last_item_id" uuid,
	"present_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_participants_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "evaluation_items" ADD CONSTRAINT "evaluation_items_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_items" ADD CONSTRAINT "evaluation_items_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_item_id_evaluation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."evaluation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_participants" ADD CONSTRAINT "guest_participants_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_items_position_uq" ON "evaluation_items" USING btree ("evaluation_id","position");--> statement-breakpoint
CREATE INDEX "evaluation_items_version_idx" ON "evaluation_items" USING btree ("question_version_id");--> statement-breakpoint
CREATE INDEX "evaluations_classroom_idx" ON "evaluations" USING btree ("classroom_id","state");--> statement-breakpoint
CREATE INDEX "evaluations_live_idx" ON "evaluations" USING btree ("state") WHERE "evaluations"."state" in ('scheduled','lobby','running','paused');--> statement-breakpoint
CREATE UNIQUE INDEX "answers_attempt_item_uq" ON "answers" USING btree ("attempt_id","item_id");--> statement-breakpoint
CREATE INDEX "answers_attempt_idx" ON "answers" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "answers_item_idx" ON "answers" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "attempt_events_attempt_idx" ON "attempt_events" USING btree ("attempt_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_evaluation_user_uq" ON "attempts" USING btree ("evaluation_id","user_id");--> statement-breakpoint
CREATE INDEX "attempts_deadline_idx" ON "attempts" USING btree ("deadline_at") WHERE "attempts"."state" = 'in_progress';--> statement-breakpoint
CREATE INDEX "attempts_evaluation_idx" ON "attempts" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "guest_participants_evaluation_idx" ON "guest_participants" USING btree ("evaluation_id");