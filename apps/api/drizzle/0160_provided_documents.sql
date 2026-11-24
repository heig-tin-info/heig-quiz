CREATE TABLE "evaluation_provided_documents" (
	"evaluation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "evaluation_provided_documents_evaluation_id_document_id_pk" PRIMARY KEY("evaluation_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "evaluation_provided_documents" ADD CONSTRAINT "evaluation_provided_documents_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_provided_documents" ADD CONSTRAINT "evaluation_provided_documents_document_id_course_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."course_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_provided_documents_document_idx" ON "evaluation_provided_documents" USING btree ("document_id");