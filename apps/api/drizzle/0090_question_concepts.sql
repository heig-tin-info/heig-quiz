CREATE TABLE "question_concepts" (
	"question_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	CONSTRAINT "question_concepts_question_id_concept_id_pk" PRIMARY KEY("question_id","concept_id")
);
--> statement-breakpoint
ALTER TABLE "question_concepts" ADD CONSTRAINT "question_concepts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_concepts" ADD CONSTRAINT "question_concepts_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_concepts_concept_idx" ON "question_concepts" USING btree ("concept_id");