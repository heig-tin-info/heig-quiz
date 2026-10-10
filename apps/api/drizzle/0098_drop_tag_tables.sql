-- Step (d) of ADR-081 (fourth addendum 2026-10-10): the tag sorting is retired.
-- Only the `drop` rows of the sorting remain, the stop list of
-- `concept_dropped`; a `concept` or pending row has no reader and its foreign
-- key would make a concept born of a tag undeletable.
DELETE FROM "concept_tag_sortings" WHERE "decision" IS DISTINCT FROM 'drop';--> statement-breakpoint
DROP TABLE "pool_tags" CASCADE;--> statement-breakpoint
DROP TABLE "question_tags" CASCADE;--> statement-breakpoint
DROP TABLE "concept_sort_runs" CASCADE;