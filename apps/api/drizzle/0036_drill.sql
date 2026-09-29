CREATE TABLE "drill_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"classroom_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"stability" double precision DEFAULT 0 NOT NULL,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"last_review_at" timestamp with time zone,
	"key_hash" text NOT NULL,
	"serve_seed" integer,
	"shown_since" timestamp with time zone,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "drill_cards_serve_ck" CHECK ("drill_cards"."serve_seed" is not null or ("drill_cards"."shown_since" is null and "drill_cards"."active_ms" = 0))
);
--> statement-breakpoint
CREATE TABLE "drill_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"correctness" text NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"device_class" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"answer_payload" jsonb,
	CONSTRAINT "drill_reviews_rating_ck" CHECK ("drill_reviews"."rating" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "classrooms" ADD COLUMN "drill_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "drill_opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD CONSTRAINT "drill_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD CONSTRAINT "drill_cards_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD CONSTRAINT "drill_cards_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_cards" ADD CONSTRAINT "drill_cards_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_reviews" ADD CONSTRAINT "drill_reviews_card_id_drill_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."drill_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drill_cards_user_question_uq" ON "drill_cards" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "drill_cards_user_due_idx" ON "drill_cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "drill_cards_question_idx" ON "drill_cards" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "drill_cards_classroom_idx" ON "drill_cards" USING btree ("classroom_id");--> statement-breakpoint
CREATE INDEX "drill_cards_evaluation_idx" ON "drill_cards" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "drill_reviews_card_idx" ON "drill_reviews" USING btree ("card_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "drill_reviews_reviewed_idx" ON "drill_reviews" USING btree ("reviewed_at");