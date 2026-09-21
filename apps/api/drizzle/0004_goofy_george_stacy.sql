CREATE TABLE "pool_tags" (
	"pool_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_tags_pool_id_tag_pk" PRIMARY KEY("pool_id","tag")
);
--> statement-breakpoint
ALTER TABLE "pool_tags" ADD CONSTRAINT "pool_tags_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Backfill: every tag already worn by a question gets its row, so the
-- vocabulary of an existing pool is complete from the first request and
-- nothing has to be repaired later.
INSERT INTO "pool_tags" ("pool_id", "tag")
SELECT DISTINCT "questions"."pool_id", "question_tags"."tag"
FROM "question_tags"
JOIN "questions" ON "questions"."id" = "question_tags"."question_id"
ON CONFLICT DO NOTHING;
