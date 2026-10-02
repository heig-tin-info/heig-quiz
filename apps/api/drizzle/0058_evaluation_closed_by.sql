ALTER TABLE "evaluations" ADD COLUMN "closed_by" text;--> statement-breakpoint
-- The runs closed before the column: the ticker closes at `closes_at` or
-- later, a person closes before it or where there is none.
UPDATE "evaluations" SET "closed_by" = CASE
  WHEN "closes_at" IS NOT NULL AND "closed_at" >= "closes_at" THEN 'server'
  ELSE 'teacher'
END WHERE "closed_at" IS NOT NULL;
