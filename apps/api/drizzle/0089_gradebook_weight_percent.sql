-- A gradebook column's weight becomes a whole percentage, 0 to 100, 100 by default (#545, ADR-074 amendment of 2026-10-08).
-- The old weights were coefficients 0 to 10 at the tenth, 1 by default. Relative weights are kept within each classroom:
-- the classroom's largest weight (the old default 1 included) becomes 100 %, the others in proportion, rounded.
ALTER TABLE "gradebook_columns" DROP CONSTRAINT "gradebook_columns_weight_range";--> statement-breakpoint
-- Tenths first, exact: 0..10 at the tenth is 0..100 as an integer.
ALTER TABLE "gradebook_columns" ALTER COLUMN "weight" SET DATA TYPE integer USING round("weight" * 10)::integer;--> statement-breakpoint
-- In a classroom whose largest weight is above the old default (10 tenths), an activity without a stored column
-- weighed 1, not the new default 100 %: store it at 1 (10 tenths) so the normalisation below reaches it too.
-- The activities that have a column are those of `gradebookEntries`: exams and exercises that are no draft,
-- graded projects that are no draft; `counts` takes its kind's default (exercises are opt-in).
INSERT INTO "gradebook_columns" ("id", "classroom_id", "evaluation_id", "weight", "counts", "updated_at")
SELECT gen_random_uuid(), e."classroom_id", e."id", 10, e."mode" = 'exam', now()
FROM "evaluations" e
WHERE e."mode" IN ('exam', 'exercise') AND e."state" <> 'draft'
  AND e."classroom_id" IN (SELECT "classroom_id" FROM "gradebook_columns" GROUP BY "classroom_id" HAVING max("weight") > 10)
  AND NOT EXISTS (SELECT 1 FROM "gradebook_columns" c WHERE c."evaluation_id" = e."id");--> statement-breakpoint
INSERT INTO "gradebook_columns" ("id", "classroom_id", "project_id", "weight", "counts", "updated_at")
SELECT gen_random_uuid(), p."classroom_id", p."id", 10, true, now()
FROM "projects" p
WHERE p."state" <> 'draft' AND p."grading_mode" = 'auto'
  AND p."classroom_id" IN (SELECT "classroom_id" FROM "gradebook_columns" GROUP BY "classroom_id" HAVING max("weight") > 10)
  AND NOT EXISTS (SELECT 1 FROM "gradebook_columns" c WHERE c."project_id" = p."id");--> statement-breakpoint
-- Normalise: divided by the classroom's largest weight in tenths, never less than the old default (10), times 100.
-- A classroom at 1 or below is multiplied by 100 exactly; one with a 2 next to 1s becomes 100 % next to 50 %.
UPDATE "gradebook_columns" c
SET "weight" = round(c."weight" * 100.0 / m."top")::integer
FROM (SELECT "classroom_id", greatest(max("weight"), 10) AS "top" FROM "gradebook_columns" GROUP BY "classroom_id") m
WHERE c."classroom_id" = m."classroom_id";--> statement-breakpoint
ALTER TABLE "gradebook_columns" ALTER COLUMN "weight" SET DEFAULT 100;--> statement-breakpoint
ALTER TABLE "gradebook_columns" ADD CONSTRAINT "gradebook_columns_weight_range" CHECK ("gradebook_columns"."weight" >= 0 AND "gradebook_columns"."weight" <= 100);
