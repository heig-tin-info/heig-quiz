CREATE TABLE "answer_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"answer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"message" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gradings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"answer_id" uuid,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"max_points" numeric(6, 2) NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"details" jsonb,
	"confidence" text,
	"comment" text,
	"graded_by" uuid,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_id" uuid,
	"regrade_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"answer_id" uuid,
	"prompt_tokens" numeric(10, 0),
	"completion_tokens" numeric(10, 0),
	"ms" numeric(10, 0),
	"ok" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_flags" ADD CONSTRAINT "answer_flags_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_flags" ADD CONSTRAINT "answer_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_flags" ADD CONSTRAINT "answer_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_item_id_evaluation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."evaluation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_graded_by_users_id_fk" FOREIGN KEY ("graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gradings" ADD CONSTRAINT "gradings_supersedes_id_gradings_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."gradings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_flags_answer_idx" ON "answer_flags" USING btree ("answer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gradings_validated_uq" ON "gradings" USING btree ("answer_id") WHERE "gradings"."state" = 'validated';--> statement-breakpoint
CREATE UNIQUE INDEX "gradings_pair_validated_uq" ON "gradings" USING btree ("attempt_id","item_id") WHERE "gradings"."state" = 'validated';--> statement-breakpoint
CREATE INDEX "gradings_answer_idx" ON "gradings" USING btree ("answer_id");--> statement-breakpoint
CREATE INDEX "gradings_attempt_idx" ON "gradings" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "gradings_item_validated_idx" ON "gradings" USING btree ("item_id") WHERE "gradings"."state" = 'validated';--> statement-breakpoint
CREATE INDEX "llm_calls_answer_idx" ON "llm_calls" USING btree ("answer_id");