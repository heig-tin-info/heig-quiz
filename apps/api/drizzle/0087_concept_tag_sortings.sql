CREATE TABLE "concept_tag_sortings" (
	"pool_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"decision" text,
	"concept_id" uuid,
	"drop_reason" text,
	"proposal" jsonb,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_tag_sortings_pool_id_tag_pk" PRIMARY KEY("pool_id","tag"),
	CONSTRAINT "concept_tag_sortings_decided_ck" CHECK (("concept_tag_sortings"."decision" is null) = ("concept_tag_sortings"."decided_at" is null)
        and ("concept_tag_sortings"."decision" is not null or ("concept_tag_sortings"."proposal" is not null and "concept_tag_sortings"."decided_by" is null))),
	CONSTRAINT "concept_tag_sortings_decision_ck" CHECK (("concept_tag_sortings"."concept_id" is not null) = ("concept_tag_sortings"."decision" is not distinct from 'concept')
        and ("concept_tag_sortings"."drop_reason" is not null) = ("concept_tag_sortings"."decision" is not distinct from 'drop'))
);
--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ADD CONSTRAINT "concept_tag_sortings_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ADD CONSTRAINT "concept_tag_sortings_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ADD CONSTRAINT "concept_tag_sortings_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_tag_sortings_concept_idx" ON "concept_tag_sortings" USING btree ("concept_id");