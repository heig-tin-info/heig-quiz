-- The database's fingerprint (docs/audits/2026-11-21-database-remediation.md,
-- rule 5): read-only, one consistent snapshot. Run it before and after a
-- migration, or against a restored dump, and diff the two outputs: every
-- line is identical unless the migration says why not.
--
--   docker compose -f compose.prod.yml --env-file .env.prod exec -T postgres \
--     psql -XAq -v ON_ERROR_STOP=1 -U quiz -d quiz < scripts/db-fingerprint.sql > fp-before.txt
--
-- Per table of `public`, `drizzle` and `import_classroom`: its row count and
-- a digest of its content (the md5 of the sorted md5s of its rows, so the
-- physical order does not matter). pg-boss's queue is left out: it changes
-- every second. Then the totals a migration that MOVES data must keep: a
-- split changes the digests of the tables it touches, never these. A PR that
-- moves one of these columns updates its line here, in the same PR.
--
-- It reads every row once: a few seconds on the application VM (4 s on
-- 2026-11-21, 172 MB).

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\pset footer off

\echo == tables: rows and content digest
SELECT
  n.nspname || '.' || c.relname AS "table",
  (xpath('/row/n/text()', query_to_xml(
    format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS rows,
  (xpath('/row/d/text()', query_to_xml(
    format('SELECT md5(coalesce(string_agg(h, '''' ORDER BY h), '''')) AS d FROM (SELECT md5(t::text) AS h FROM %I.%I t) s',
      n.nspname, c.relname), false, true, '')))[1]::text AS digest
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle', 'import_classroom')
ORDER BY 1;

\echo == totals that must survive a migration
SELECT k AS "total", v AS "value" FROM (
  SELECT 1 AS o, 'evaluations released' AS k, count(*)::text AS v FROM evaluations WHERE released_at IS NOT NULL
  UNION ALL SELECT 2, 'attempts submitted', count(*)::text FROM attempts WHERE submitted_at IS NOT NULL
  UNION ALL SELECT 3, 'answers', count(*)::text FROM answers
  UNION ALL SELECT 4, 'gradings validated: count, points, max',
    count(*) || ' ' || coalesce(sum(points), 0) || ' ' || coalesce(sum(max_points), 0) FROM gradings WHERE state = 'validated'
  UNION ALL SELECT 5, 'project criterion grades validated: count, points, max',
    count(*) || ' ' || coalesce(sum(points), 0) || ' ' || coalesce(sum(max), 0) FROM project_criterion_grades WHERE state = 'validated'
  UNION ALL SELECT 6, 'project repos teacher score: count, points, max',
    count(teacher_points) || ' ' || coalesce(round(sum(teacher_points)::numeric, 6), 0) || ' ' || coalesce(round(sum(teacher_max)::numeric, 6), 0) FROM project_repos
  UNION ALL SELECT 7, 'project repos released: count, points, max, grade',
    count(released_points) || ' ' || coalesce(round(sum(released_points)::numeric, 6), 0) || ' '
    || coalesce(round(sum(released_max)::numeric, 6), 0) || ' ' || coalesce(round(sum(released_grade)::numeric, 6), 0) FROM project_repos
  UNION ALL SELECT 8, 'project repos adjusted: count, value',
    count(grade_adjust_kind) || ' ' || coalesce(round(sum(grade_adjust_value)::numeric, 6), 0) FROM project_repos
  UNION ALL SELECT 9, 'project grade runs: count, points, max',
    count(*) || ' ' || coalesce(round(sum(points)::numeric, 6), 0) || ' ' || coalesce(round(sum(max)::numeric, 6), 0) FROM project_grade_runs
  UNION ALL SELECT 10, 'gradebook marks: count, points, max',
    count(*) || ' ' || coalesce(sum(points), 0) || ' ' || coalesce(sum(max), 0) FROM gradebook_marks
  UNION ALL SELECT 11, 'enrollments claimed', count(*)::text FROM enrollments WHERE user_id IS NOT NULL
  UNION ALL SELECT 12, 'audit log rows', count(*)::text FROM audit_log
) t
ORDER BY o;

COMMIT;
