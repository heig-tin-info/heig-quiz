CREATE TABLE "concept_relations" (
	"concept_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_relations_concept_id_target_id_kind_pk" PRIMARY KEY("concept_id","target_id","kind"),
	CONSTRAINT "concept_relations_distinct_ck" CHECK ("concept_relations"."concept_id" <> "concept_relations"."target_id"),
	CONSTRAINT "concept_relations_related_order_ck" CHECK ("concept_relations"."kind" <> 'related' or "concept_relations"."concept_id" < "concept_relations"."target_id")
);
--> statement-breakpoint
ALTER TABLE "concept_relations" ADD CONSTRAINT "concept_relations_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_relations" ADD CONSTRAINT "concept_relations_target_id_concepts_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_relations" ADD CONSTRAINT "concept_relations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_relations_target_idx" ON "concept_relations" USING btree ("target_id");