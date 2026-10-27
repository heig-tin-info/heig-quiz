ALTER TABLE "project_repos" ADD COLUMN "released_grade" double precision;--> statement-breakpoint
-- ADR-119 §11 (L-06b): the `score_is_grade` scale leaves every project. One
-- statement, so every part reads the rows as they stood before it:
--
-- 1. every score out of 6 (a mark g) becomes (g − 1) out of 5, clamped to
--    [0, 5], so that the linear scale gives g back: the released score, the
--    teacher's, every run of the project's repositories (whichever slot it
--    fills) and the staff's `score` marks of the project's gradebook column
--    (ADR-074). A score with another maximum was already read linearly and
--    stays. The teacher's score is a mark when `teacher_max` is 6, or when
--    it is null (heig-classroom's imported rows, `auto` mode only) and the
--    run it is read against is out of 6: the review's, else the frozen,
--    else the current, as `resolveFinalScore` reads it; `criteriaScore.max`
--    is skipped on purpose, no such row being graded by criteria.
--    `teacher_max` is then written, 5, as the import writes it;
-- 2. the project's scale becomes linear, its rounding kept;
-- 3. one `project.scale_migrated` audit entry per project (`apps/api/src/
--    audit.ts`), by the system, with what was converted.
WITH "migrated" AS (
  SELECT "id", "released_at" IS NOT NULL AS "released"
  FROM "projects"
  WHERE "grading_scale"->>'kind' = 'score_is_grade'
),
"before" AS (
  SELECT r."id", m."id" AS "project_id", r."released_points", r."released_max", r."teacher_points",
    coalesce(
      r."teacher_max",
      (SELECT g."max" FROM "project_grade_runs" g WHERE g."id" = r."review_grade_run_id" AND g."parse_status" = 'ok' AND g."points" IS NOT NULL),
      (SELECT g."max" FROM "project_grade_runs" g WHERE g."id" = r."frozen_grade_run_id" AND g."parse_status" = 'ok' AND g."points" IS NOT NULL),
      (SELECT g."max" FROM "project_grade_runs" g WHERE g."id" = r."current_grade_run_id" AND g."parse_status" = 'ok' AND g."points" IS NOT NULL)
    ) AS "teacher_read_max"
  FROM "project_repos" r
  JOIN "migrated" m ON m."id" = r."project_id"
),
"facts" AS (
  SELECT b.*,
    b."teacher_points" IS NOT NULL AND coalesce(b."teacher_read_max" = 6, false) AS "teacher_mark",
    coalesce(b."released_max" = 6, false) AS "released_mark"
  FROM "before" b
),
"repos" AS (
  UPDATE "project_repos" r SET
    "released_points" = CASE WHEN f."released_mark" THEN least(5, greatest(0, f."released_points" - 1)) ELSE f."released_points" END,
    "released_max" = CASE WHEN f."released_mark" THEN 5 ELSE f."released_max" END,
    "teacher_points" = CASE WHEN f."teacher_mark" THEN least(5, greatest(0, f."teacher_points" - 1)) ELSE f."teacher_points" END,
    "teacher_max" = CASE WHEN f."teacher_mark" THEN 5 ELSE r."teacher_max" END
  FROM "facts" f
  WHERE r."id" = f."id"
  RETURNING f."project_id", f."teacher_mark", f."released_mark"
),
"runs" AS (
  UPDATE "project_grade_runs" g SET
    "points" = least(5, greatest(0, g."points" - 1)),
    "max" = 5
  FROM "before" b
  WHERE g."repo_id" = b."id" AND g."max" = 6 AND g."points" IS NOT NULL
  RETURNING b."project_id"
),
"marks" AS (
  UPDATE "gradebook_marks" k SET
    "points" = least(5, greatest(0, k."points" - 1)),
    "max" = 5
  FROM "gradebook_columns" c
  JOIN "migrated" m ON m."id" = c."project_id"
  WHERE k."column_id" = c."id" AND k."kind" = 'score' AND k."max" = 6
  RETURNING m."id" AS "project_id"
),
"scales" AS (
  UPDATE "projects" p SET "grading_scale" = jsonb_set(p."grading_scale", '{kind}', '"linear"')
  FROM "migrated" m
  WHERE p."id" = m."id"
  RETURNING p."id"
)
INSERT INTO "audit_log" ("actor_type", "action", "subject_type", "subject_id", "payload")
SELECT 'system', 'project.scale_migrated', 'project', m."id"::text, jsonb_build_object(
  'from', 'score_is_grade',
  'released', m."released",
  'runs', (SELECT count(*) FROM "runs" x WHERE x."project_id" = m."id"),
  'teacherScores', (SELECT count(*) FROM "repos" x WHERE x."project_id" = m."id" AND x."teacher_mark"),
  'releasedScores', (SELECT count(*) FROM "repos" x WHERE x."project_id" = m."id" AND x."released_mark"),
  'gradebookMarks', (SELECT count(*) FROM "marks" x WHERE x."project_id" = m."id")
)
FROM "migrated" m
JOIN "scales" s ON s."id" = m."id";--> statement-breakpoint
-- Every released grade is stored (ADR-119 §11), whatever the project's
-- scale was: the grade its release gave, from the released score (converted
-- above), 1 + 5 × points / max rounded to the tenth by the project's
-- rounding (half away from zero, with `round.ts`'s epsilon) and clamped to
-- 1…6 — `gradeFromPoints` (`@quiz/domain`). The readers of the release read
-- it, never a recomputation: a rounding edited afterwards moves nothing.
UPDATE "project_repos" r SET "released_grade" = least(6, greatest(1, (CASE coalesce(p."grading_scale"->>'rounding', 'nearest')
    WHEN 'up' THEN ceil((1 + 5 * (r."released_points" / r."released_max")) * 10 - 1e-9)
    WHEN 'down' THEN floor((1 + 5 * (r."released_points" / r."released_max")) * 10 + 1e-9)
    ELSE floor((1 + 5 * (r."released_points" / r."released_max")) * 10 + 1e-9 + 0.5)
  END) / 10))
FROM "projects" p
WHERE p."id" = r."project_id" AND p."released_at" IS NOT NULL AND r."released_points" IS NOT NULL AND r."released_max" > 0;
