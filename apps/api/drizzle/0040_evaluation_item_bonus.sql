ALTER TABLE "evaluation_items" ADD COLUMN "bonus" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- ADR-052: the `threshold` grade scale is gone; a row that used it becomes
-- linear, keeping its rounding. Templates are rows of this table too.
UPDATE "evaluations" SET "grading_scale" = jsonb_build_object('kind', 'linear', 'rounding', coalesce("grading_scale"->>'rounding', 'nearest')) WHERE "grading_scale"->>'kind' = 'threshold';--> statement-breakpoint
-- The frozen snapshot of a release (ADR-012) carries the scale it was
-- computed with: its grades stay as frozen, only the scale is relabelled so
-- the snapshot still parses.
UPDATE "evaluations" SET "released_grades" = jsonb_set("released_grades", '{scale}', jsonb_build_object('kind', 'linear', 'rounding', coalesce("released_grades"->'scale'->>'rounding', 'nearest'))) WHERE "released_grades"->'scale'->>'kind' = 'threshold';
