CREATE TABLE "drill_revision_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"round_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"pass" smallint NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"correctness" text,
	"time_ms" integer,
	"serve_seed" integer NOT NULL,
	"serve_values" jsonb,
	CONSTRAINT "drill_revision_answers_pass_ck" CHECK ("drill_revision_answers"."pass" in (1, 2)),
	CONSTRAINT "drill_revision_answers_time_ck" CHECK ("drill_revision_answers"."time_ms" between 0 and 600000),
	CONSTRAINT "drill_revision_answers_answered_ck" CHECK (("drill_revision_answers"."answered_at" is null) = ("drill_revision_answers"."correctness" is null) and ("drill_revision_answers"."answered_at" is null) = ("drill_revision_answers"."time_ms" is null))
);
--> statement-breakpoint
CREATE TABLE "drill_revision_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"classroom_id" uuid NOT NULL,
	"concept_id" uuid,
	"card_ids" uuid[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"cards_served" integer DEFAULT 0 NOT NULL,
	"cards_correct" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "drill_revision_rounds_cards_ck" CHECK (cardinality("drill_revision_rounds"."card_ids") between 1 and 10),
	CONSTRAINT "drill_revision_rounds_counts_ck" CHECK ("drill_revision_rounds"."cards_correct" >= 0 and "drill_revision_rounds"."cards_correct" <= "drill_revision_rounds"."cards_served" and "drill_revision_rounds"."cards_served" <= cardinality("drill_revision_rounds"."card_ids")),
	CONSTRAINT "drill_revision_rounds_ended_ck" CHECK ("drill_revision_rounds"."ended_at" is null or "drill_revision_rounds"."ended_at" >= "drill_revision_rounds"."started_at")
);
--> statement-breakpoint
ALTER TABLE "drill_revision_answers" ADD CONSTRAINT "drill_revision_answers_round_id_drill_revision_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."drill_revision_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_revision_answers" ADD CONSTRAINT "drill_revision_answers_card_id_drill_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."drill_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_revision_rounds" ADD CONSTRAINT "drill_revision_rounds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_revision_rounds" ADD CONSTRAINT "drill_revision_rounds_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_revision_rounds" ADD CONSTRAINT "drill_revision_rounds_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drill_revision_answers_pass_uq" ON "drill_revision_answers" USING btree ("round_id","card_id","pass");--> statement-breakpoint
CREATE INDEX "drill_revision_answers_card_idx" ON "drill_revision_answers" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "drill_revision_rounds_classroom_idx" ON "drill_revision_rounds" USING btree ("classroom_id","started_at");--> statement-breakpoint
CREATE INDEX "drill_revision_rounds_user_idx" ON "drill_revision_rounds" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "drill_revision_rounds_concept_idx" ON "drill_revision_rounds" USING btree ("concept_id");