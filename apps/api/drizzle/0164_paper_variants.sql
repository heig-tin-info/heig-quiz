CREATE TABLE "paper_variants" (
	"evaluation_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"seed" integer NOT NULL,
	"instances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_variants_evaluation_id_number_pk" PRIMARY KEY("evaluation_id","number"),
	CONSTRAINT "paper_variants_number_ck" CHECK ("paper_variants"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "paper_variants" ADD CONSTRAINT "paper_variants_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ADR-148: the seed every print so far followed becomes variant 1, with no values
-- stored (a parameterized evaluation did not print before). Idempotent.
INSERT INTO "paper_variants" ("evaluation_id", "number", "seed", "instances", "created_at", "updated_at")
SELECT "id", 1, "paper_seed", '{}'::jsonb, now(), now() FROM "evaluations" WHERE "paper_seed" IS NOT NULL
ON CONFLICT DO NOTHING;
