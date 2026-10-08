-- The cut-over from tags to concepts (ADR-081, third addendum 2026-10-08 §2):
-- every live question gets the concepts its (pool, tag) pairs were accepted
-- into by the admin's sorting, following `merged_into` (always the final
-- concept, addendum §3). Pairs worn only by deleted questions are not carried
-- over; a pair without an accepted decision is left for the sorting screen,
-- whose later accept adds its links (third addendum §3). `question_tags` and
-- `pool_tags` are frozen from here on, and dropped once no pair is pending.
INSERT INTO "question_concepts" ("question_id", "concept_id")
SELECT DISTINCT qt."question_id", coalesce(c."merged_into", c."id")
FROM "question_tags" qt
JOIN "questions" q ON q."id" = qt."question_id" AND q."deleted_at" IS NULL
JOIN "concept_tag_sortings" s
  ON s."pool_id" = q."pool_id" AND s."tag" = qt."tag" AND s."decision" = 'concept'
JOIN "concepts" c ON c."id" = s."concept_id"
ON CONFLICT DO NOTHING;
