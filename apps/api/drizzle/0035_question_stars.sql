CREATE TABLE "question_stars" (
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"starred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_stars_user_id_question_id_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
ALTER TABLE "question_stars" ADD CONSTRAINT "question_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_stars" ADD CONSTRAINT "question_stars_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_stars_question_idx" ON "question_stars" USING btree ("question_id");