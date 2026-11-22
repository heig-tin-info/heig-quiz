-- Read-only audit before the integrity phase of
-- docs/audits/2026-11-21-database-remediation.md (Phase 0.4): what the
-- constraints of Phases 3 and 4 would refuse in the data as it is. Every
-- section counts; none prints personal data (no name, no address, no
-- answer). An empty section, or only zero counts, means the constraint can
-- be added with no fix-up.
--
--   docker compose -f compose.prod.yml --env-file .env.prod exec -T postgres \
--     psql -XAq -v ON_ERROR_STOP=1 -U quiz -d quiz < scripts/db-audit.sql

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\pset footer off

\echo == 3.1 values of the state and role columns (column | value | rows)
SELECT 'users.role' AS col, role AS value, count(*) AS n FROM users GROUP BY 2
UNION ALL SELECT 'course_staff.role', role, count(*) FROM course_staff GROUP BY 2
UNION ALL SELECT 'pool_members.role', role, count(*) FROM pool_members GROUP BY 2
UNION ALL SELECT 'sessions.kind', kind, count(*) FROM sessions GROUP BY 2
UNION ALL SELECT 'attempts.state', state, count(*) FROM attempts GROUP BY 2
UNION ALL SELECT 'attempts.origin', origin, count(*) FROM attempts GROUP BY 2
UNION ALL SELECT 'attempts.closed_by', closed_by, count(*) FROM attempts GROUP BY 2
UNION ALL SELECT 'gradings.state', state, count(*) FROM gradings GROUP BY 2
UNION ALL SELECT 'gradings.source', source, count(*) FROM gradings GROUP BY 2
UNION ALL SELECT 'contestations.state', state, count(*) FROM contestations GROUP BY 2
UNION ALL SELECT 'project_contestations.state', state, count(*) FROM project_contestations GROUP BY 2
UNION ALL SELECT 'project_criterion_grades.state', state, count(*) FROM project_criterion_grades GROUP BY 2
UNION ALL SELECT 'project_criterion_grades.source', source, count(*) FROM project_criterion_grades GROUP BY 2
UNION ALL SELECT 'projects.state', state, count(*) FROM projects GROUP BY 2
UNION ALL SELECT 'projects.grading_mode', grading_mode, count(*) FROM projects GROUP BY 2
UNION ALL SELECT 'projects.deadline_strategy', deadline_strategy, count(*) FROM projects GROUP BY 2
UNION ALL SELECT 'projects.source_strategy', source_strategy, count(*) FROM projects GROUP BY 2
UNION ALL SELECT 'projects.publish_mode', publish_mode, count(*) FROM projects GROUP BY 2
UNION ALL SELECT 'project_repos.provision_status', provision_status, count(*) FROM project_repos GROUP BY 2
UNION ALL SELECT 'project_repos.invitation_status', invitation_status, count(*) FROM project_repos GROUP BY 2
UNION ALL SELECT 'project_repos.ci_status', ci_status, count(*) FROM project_repos GROUP BY 2
UNION ALL SELECT 'project_repos.grade_adjust_kind', grade_adjust_kind, count(*) FROM project_repos GROUP BY 2
UNION ALL SELECT 'kiosk_pairings.state', state, count(*) FROM kiosk_pairings GROUP BY 2
UNION ALL SELECT 'kiosk_devices.status', status, count(*) FROM kiosk_devices GROUP BY 2
UNION ALL SELECT 'launch_tickets.kind', kind, count(*) FROM launch_tickets GROUP BY 2
UNION ALL SELECT 'course_pools.mode', mode, count(*) FROM course_pools GROUP BY 2
UNION ALL SELECT 'evaluation_items.counting', counting, count(*) FROM evaluation_items GROUP BY 2
UNION ALL SELECT 'evaluations.mcq_policy', mcq_policy, count(*) FROM evaluations GROUP BY 2
UNION ALL SELECT 'question_reviews.state', state, count(*) FROM question_reviews GROUP BY 2
UNION ALL SELECT 'questions.type', type, count(*) FROM questions GROUP BY 2
ORDER BY 1, 2;

\echo == 3.2 addresses not normalized, and the collisions normalizing them would make (check | rows)
SELECT 'user_emails not normalized' AS "check", count(*) AS n FROM user_emails WHERE email <> lower(btrim(email))
UNION ALL SELECT 'enrollments not normalized', count(*) FROM enrollments WHERE email <> lower(btrim(email))
UNION ALL SELECT 'teacher_grants not normalized', count(*) FROM teacher_grants WHERE email <> lower(btrim(email))
UNION ALL SELECT 'users not normalized (stays as sent, information only)', count(*) FROM users WHERE email <> lower(btrim(email))
UNION ALL SELECT 'user_emails collisions', count(*) FROM (
  SELECT 1 FROM user_emails GROUP BY user_id, lower(btrim(email)) HAVING count(*) > 1) s
UNION ALL SELECT 'enrollments collisions', count(*) FROM (
  SELECT 1 FROM enrollments GROUP BY classroom_id, lower(btrim(email)) HAVING count(*) > 1) s
UNION ALL SELECT 'teacher_grants collisions', count(*) FROM (
  SELECT 1 FROM teacher_grants GROUP BY lower(btrim(email)) HAVING count(*) > 1) s;

\echo == 4 float8 points: values with more than two decimals, and the largest magnitude (column | non-null | over 2 decimals | max abs)
SELECT col, n, over2, maxabs FROM (
  SELECT 'project_repos.teacher_points' AS col, count(v) AS n, count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)) AS over2, max(abs(v)) AS maxabs
    FROM (SELECT teacher_points AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.teacher_max', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT teacher_max AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.released_points', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT released_points AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.released_max', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT released_max AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.released_grade', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT released_grade AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.grade_adjust_value', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT grade_adjust_value AS v FROM project_repos) s
  UNION ALL SELECT 'project_repos.grade_adjust_base', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT grade_adjust_base AS v FROM project_repos) s
  UNION ALL SELECT 'project_grade_runs.points', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT points AS v FROM project_grade_runs) s
  UNION ALL SELECT 'project_grade_runs.max', count(v), count(*) FILTER (WHERE v::numeric <> round(v::numeric, 2)), max(abs(v)) FROM (SELECT max AS v FROM project_grade_runs) s
) t
ORDER BY col;

\echo == 3.4 references without a foreign key: dangling, or pointing to another parent (check | rows)
SELECT 'project_repos.current_grade_run_id missing' AS "check", count(*) AS n FROM project_repos r
  WHERE r.current_grade_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_grade_runs g WHERE g.id = r.current_grade_run_id)
UNION ALL SELECT 'project_repos.current_grade_run_id of another repo', count(*) FROM project_repos r
  JOIN project_grade_runs g ON g.id = r.current_grade_run_id WHERE g.repo_id <> r.id
UNION ALL SELECT 'project_repos.frozen_grade_run_id missing', count(*) FROM project_repos r
  WHERE r.frozen_grade_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_grade_runs g WHERE g.id = r.frozen_grade_run_id)
UNION ALL SELECT 'project_repos.frozen_grade_run_id of another repo', count(*) FROM project_repos r
  JOIN project_grade_runs g ON g.id = r.frozen_grade_run_id WHERE g.repo_id <> r.id
UNION ALL SELECT 'project_repos.review_grade_run_id missing', count(*) FROM project_repos r
  WHERE r.review_grade_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_grade_runs g WHERE g.id = r.review_grade_run_id)
UNION ALL SELECT 'project_repos.review_grade_run_id of another repo', count(*) FROM project_repos r
  JOIN project_grade_runs g ON g.id = r.review_grade_run_id WHERE g.repo_id <> r.id
UNION ALL SELECT 'project_criterion_grades.pass_id set', count(*) FROM project_criterion_grades WHERE pass_id IS NOT NULL
UNION ALL SELECT 'project_criterion_grades.pass_id found in grade_dispatches', count(*) FROM project_criterion_grades c
  WHERE EXISTS (SELECT 1 FROM grade_dispatches d WHERE d.id = c.pass_id)
UNION ALL SELECT 'project_criterion_grades.pass_id found in project_evidence', count(*) FROM project_criterion_grades c
  WHERE EXISTS (SELECT 1 FROM project_evidence e WHERE e.id = c.pass_id)
UNION ALL SELECT 'project_criterion_grades.pass_id of another repo (grade_dispatches)', count(*) FROM project_criterion_grades c
  JOIN grade_dispatches d ON d.id = c.pass_id WHERE d.repo_id <> c.repo_id
UNION ALL SELECT 'attempts.last_item_id missing', count(*) FROM attempts a
  WHERE a.last_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evaluation_items i WHERE i.id = a.last_item_id)
UNION ALL SELECT 'attempts.last_item_id of another evaluation', count(*) FROM attempts a
  JOIN evaluation_items i ON i.id = a.last_item_id WHERE i.evaluation_id <> a.evaluation_id
UNION ALL SELECT 'attempts.shown_item_id missing', count(*) FROM attempts a
  WHERE a.shown_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evaluation_items i WHERE i.id = a.shown_item_id)
UNION ALL SELECT 'attempts.shown_item_id of another evaluation', count(*) FROM attempts a
  JOIN evaluation_items i ON i.id = a.shown_item_id WHERE i.evaluation_id <> a.evaluation_id;

\echo == 3.3 duplicated parent keys that disagree (check | rows)
SELECT 'gradings whose answer is of another attempt or item' AS "check", count(*) AS n FROM gradings g
  JOIN answers a ON a.id = g.answer_id WHERE a.attempt_id <> g.attempt_id OR a.item_id <> g.item_id
UNION ALL SELECT 'gradings whose item is of another evaluation than the attempt', count(*) FROM gradings g
  JOIN attempts t ON t.id = g.attempt_id JOIN evaluation_items i ON i.id = g.item_id WHERE i.evaluation_id <> t.evaluation_id
UNION ALL SELECT 'answers whose item is of another evaluation than the attempt', count(*) FROM answers a
  JOIN attempts t ON t.id = a.attempt_id JOIN evaluation_items i ON i.id = a.item_id WHERE i.evaluation_id <> t.evaluation_id
UNION ALL SELECT 'contestations whose item is of another evaluation than the attempt', count(*) FROM contestations c
  JOIN attempts t ON t.id = c.attempt_id JOIN evaluation_items i ON i.id = c.item_id WHERE i.evaluation_id <> t.evaluation_id
UNION ALL SELECT 'project_group_members whose group is of another project', count(*) FROM project_group_members m
  JOIN project_groups g ON g.id = m.group_id WHERE g.project_id <> m.project_id
UNION ALL SELECT 'project_repos whose group is of another project', count(*) FROM project_repos r
  JOIN project_groups g ON g.id = r.group_id WHERE g.project_id <> r.project_id;

\echo == 4 project_repos: the grading columns in use (column group | rows with a value)
SELECT 'teacher score' AS "group", count(*) FILTER (WHERE teacher_points IS NOT NULL OR teacher_comment IS NOT NULL) AS n FROM project_repos
UNION ALL SELECT 'adjustment', count(*) FILTER (WHERE grade_adjust_kind IS NOT NULL) FROM project_repos
UNION ALL SELECT 'released snapshot', count(*) FILTER (WHERE released_points IS NOT NULL OR released_grade IS NOT NULL OR released_comment IS NOT NULL) FROM project_repos
UNION ALL SELECT 'all rows', count(*) FROM project_repos;

COMMIT;
