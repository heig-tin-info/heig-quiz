-- ADR-035 / ADR-030 addendum 2026-09-30 (merge task M1-03): the `activity_available`
-- payload becomes kind-neutral, `{activityKind, activityId, activityTitle}` instead of
-- `{evaluationId, evaluationTitle}`. Every stored row is about an evaluation (the only
-- kind so far); rewriting them keeps them in the bell, whose reader drops a payload that
-- no longer parses. Idempotent: a rewritten row has no `evaluationId` key any more.
-- `evaluation_id` (the cascade column) is left as it is: it already names the evaluation.
UPDATE "notifications"
SET "payload" = ("payload" - 'evaluationId' - 'evaluationTitle')
  || jsonb_build_object(
    'activityKind', 'evaluation',
    'activityId', "payload"->'evaluationId',
    'activityTitle', "payload"->'evaluationTitle'
  )
WHERE "payload"->>'kind' = 'activity_available' AND "payload"->>'evaluationId' IS NOT NULL;
