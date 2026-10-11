-- What scripts/staging-export.sh runs on the scratch copy of production
-- (`staging_export`, in production's own PostgreSQL) before dumping it for
-- staging (ADR-028, update 2026-10-11; audit M9), and what
-- apps/api/src/stagingScrub.db.test.ts runs against the real migrations,
-- followed by scripts/staging-scrub.sql.
--
-- It replaces who people are, not what they did. Replaced:
--   users          email `<role>-<n>@example.invalid`, given name the role
--                  ("Student"), family name `<n>`, OIDC subject
--                  `staging:<id>` (no identity provider issues it), no
--                  edu-ID identifier, no picture;
--   user_emails    the account's new address only;
--   teacher_grants a grant follows its teacher's new address (one per
--                  teacher), any other one becomes `grant-<n>@example.invalid`;
--   enrollments    a roster row takes its person's identity (claimed, or
--                  unclaimed under one of that person's addresses), any
--                  other one becomes `enrollment-<n>@example.invalid`; the
--                  teacher's note goes;
--   github_accounts, project_repo_access   a negative id, `github-user-<n>`;
--   project_repos  `<org>/repo-<id>` (a student repository names its student);
--   student_groups, project_groups   `Group <n>` (slug `group-<n>`), and
--                  group_sets `Groups <n>` (a group may be named after its
--                  members);
--   guest_participants   `Guest <n>` (a chosen pseudonym may be a real name).
-- Emptied, as free text beside the content that names people: IdP claims
-- (the affiliations stay: they name nobody and the role rule reads them),
-- avatars, Teams links, audit and legacy audit payloads (and a subject that
-- is an address), notifications, webhook payloads and errors, the scheduled
-- tasks' last messages.
-- Kept: grades, answers, questions, journals, projects, and the free text
-- people wrote in them. Kept as well, and named here so that nobody
-- believes otherwise: GitHub organization logins and the repository names
-- under them, which name a person when the App was installed on a personal
-- account.
--
-- The keep list: the accounts that must still work on staging (the product
-- owner's, a tester's) are left untouched, with every address they are
-- known by, their roster rows and their GitHub account. It is the
-- comma-separated setting `quiz.staging_keep_emails`, matched without case
-- against every address of an account; staging-export.sh sets it from
-- STAGING_KEEP_EMAILS or `--keep`. Unset, nobody is kept. A login finds its
-- account by `oidc_sub`, which a pseudonymized account no longer carries:
-- anyone not kept who signs in on staging gets a new, empty account.
--
-- Idempotent: a second run leaves the data as the first left it. Every
-- table named here exists in production since migration 0096.
DO $$
DECLARE
  keep text[] := array_remove(
    string_to_array(lower(regexp_replace(coalesce(current_setting('quiz.staging_keep_emails', true), ''), '\s', '', 'g')), ','),
    '');
  kept text[];
  people bigint;
BEGIN
  -- The people to pseudonymize, numbered per role in the order they came.
  CREATE TEMP TABLE staging_people ON COMMIT DROP AS
  SELECT u.id,
         u.role || '-' || n.n || '@example.invalid' AS new_email,
         initcap(u.role) AS given_name,
         n.n::text AS family_name,
         u.email_verified OR EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.verified) AS verified
  FROM users u
  JOIN (SELECT id, row_number() OVER (PARTITION BY role ORDER BY created_at, id) AS n FROM users) n ON n.id = u.id
  WHERE lower(u.email) <> ALL (keep)
    AND NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND lower(e.email) = ANY (keep));
  SELECT count(*) INTO people FROM staging_people;

  -- Every address they are known by, and every address of a kept account
  -- (a grant or a roster row under any of those stays with its person).
  CREATE TEMP TABLE staging_addresses ON COMMIT DROP AS
  SELECT u.id AS user_id, lower(u.email) AS email FROM users u JOIN staging_people p ON p.id = u.id
  UNION
  SELECT e.user_id, lower(e.email) FROM user_emails e JOIN staging_people p ON p.id = e.user_id;
  SELECT keep || coalesce(array_agg(DISTINCT a.email), '{}') INTO kept
  FROM (
    SELECT lower(u.email) AS email FROM users u WHERE u.id NOT IN (SELECT id FROM staging_people)
    UNION
    SELECT lower(e.email) FROM user_emails e WHERE e.user_id NOT IN (SELECT id FROM staging_people)
  ) a;
  RAISE NOTICE 'staging-pseudonymize: % account(s) kept as they are, % pseudonymized',
    (SELECT count(*) FROM users) - people, people;

  UPDATE teacher_grants g SET email = m.new_email
  FROM (
    SELECT DISTINCT ON (p.id) g2.id AS grant_id, p.new_email
    FROM teacher_grants g2
    JOIN staging_addresses a ON a.email = lower(g2.email)
    JOIN staging_people p ON p.id = a.user_id
    ORDER BY p.id, g2.created_at, g2.id
  ) m
  WHERE g.id = m.grant_id AND g.email <> m.new_email;
  UPDATE teacher_grants g SET email = 'grant-' || r.n || '@example.invalid'
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM teacher_grants) r
  WHERE g.id = r.id AND g.email NOT LIKE '%@example.invalid' AND lower(g.email) <> ALL (kept);

  -- The rosters. An unclaimed row under a person's address takes that
  -- person's identity, once per class, unless the person is claimed there.
  UPDATE enrollments e
  SET email = p.new_email, prenom = p.given_name, nom = p.family_name, note = NULL
  FROM staging_people p
  WHERE e.user_id = p.id;
  UPDATE enrollments e
  SET email = m.new_email, prenom = m.given_name, nom = m.family_name, note = NULL
  FROM (
    SELECT DISTINCT ON (e2.classroom_id, p.id) e2.id, p.new_email, p.given_name, p.family_name
    FROM enrollments e2
    JOIN staging_addresses a ON a.email = lower(e2.email)
    JOIN staging_people p ON p.id = a.user_id
    WHERE e2.user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM enrollments o WHERE o.classroom_id = e2.classroom_id AND o.user_id = p.id)
    ORDER BY e2.classroom_id, p.id, e2.id
  ) m
  WHERE e.id = m.id AND e.email <> m.new_email;
  UPDATE enrollments e
  SET email = 'enrollment-' || r.n || '@example.invalid', prenom = 'Enrollment', nom = r.n::text, note = NULL
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollments WHERE user_id IS NULL) r
  WHERE e.id = r.id AND e.email NOT LIKE '%@example.invalid' AND lower(e.email) <> ALL (kept);

  -- The accounts.
  UPDATE users u
  SET email = p.new_email, given_name = p.given_name, family_name = p.family_name,
      oidc_sub = 'staging:' || u.id, swiss_edu_id = NULL, picture_url = NULL
  FROM staging_people p
  WHERE u.id = p.id;
  DELETE FROM user_emails e USING staging_people p WHERE e.user_id = p.id AND e.email <> p.new_email;
  INSERT INTO user_emails (user_id, email, source, verified)
  SELECT id, new_email, 'login', verified FROM staging_people
  ON CONFLICT DO NOTHING;
  UPDATE user_idp_claims c SET claims = '{}'::jsonb
  FROM staging_people p WHERE c.user_id = p.id AND c.claims <> '{}'::jsonb;
  DELETE FROM avatars a USING staging_people p WHERE a.user_id = p.id;
  -- A Teams link is a person's Teams identity, and the address staging
  -- would message them at.
  DELETE FROM teams_links t USING staging_people p WHERE t.user_id = p.id;

  -- GitHub identities: negative ids, which GitHub never issues. The seats
  -- of a kept account keep theirs.
  CREATE TEMP TABLE staging_github ON COMMIT DROP AS
  SELECT ids.id AS old_id, row_number() OVER (ORDER BY min(ids.seen), ids.id) AS n
  FROM (
    SELECT a.github_user_id AS id, a.linked_at AS seen
    FROM github_accounts a JOIN staging_people p ON p.id = a.user_id
    UNION ALL
    SELECT r.github_user_id, r.invited_at FROM project_repo_access r
    WHERE NOT EXISTS (
      SELECT 1 FROM github_accounts a
      WHERE a.github_user_id = r.github_user_id AND a.user_id NOT IN (SELECT id FROM staging_people))
  ) ids
  WHERE ids.id > 0
  GROUP BY ids.id;
  UPDATE github_accounts a SET github_user_id = -m.n, login = 'github-user-' || m.n
  FROM staging_github m WHERE a.github_user_id = m.old_id;
  UPDATE project_repo_access r SET github_user_id = -m.n, github_login = 'github-user-' || m.n
  FROM staging_github m WHERE r.github_user_id = m.old_id;
  UPDATE project_repos r SET full_name = split_part(r.full_name, '/', 1) || '/repo-' || left(r.id::text, 8)
  FROM staging_people p
  WHERE r.user_id = p.id AND r.full_name IS NOT NULL
    AND r.full_name <> split_part(r.full_name, '/', 1) || '/repo-' || left(r.id::text, 8);

  -- Group names, unique within their set or project: a row to rename takes
  -- its id first, so that two groups never swap names mid-statement.
  CREATE TEMP TABLE staging_groups ON COMMIT DROP AS
  SELECT id, 'Group ' || row_number() OVER (PARTITION BY set_id ORDER BY position, id) AS name
  FROM student_groups;
  UPDATE student_groups g SET name = g.id::text FROM staging_groups t WHERE g.id = t.id AND g.name <> t.name;
  UPDATE student_groups g SET name = t.name FROM staging_groups t WHERE g.id = t.id AND g.name = g.id::text;
  CREATE TEMP TABLE staging_project_groups ON COMMIT DROP AS
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY position, id) AS n FROM project_groups;
  UPDATE project_groups g SET name = g.id::text, slug = g.id::text
  FROM staging_project_groups t WHERE g.id = t.id AND (g.name <> 'Group ' || t.n OR g.slug <> 'group-' || t.n);
  UPDATE project_groups g SET name = 'Group ' || t.n, slug = 'group-' || t.n
  FROM staging_project_groups t WHERE g.id = t.id AND g.name = g.id::text;
  UPDATE group_sets s SET name = 'Groups ' || r.n
  FROM (SELECT id, row_number() OVER (PARTITION BY classroom_id ORDER BY created_at, id) AS n FROM group_sets) r
  WHERE s.id = r.id AND s.name <> 'Groups ' || r.n;

  UPDATE guest_participants g SET pseudonym = 'Guest ' || r.n
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM guest_participants WHERE pseudonym IS NOT NULL) r
  WHERE g.id = r.id;

  -- Free text beside the content. The trigger that keeps `audit_log`
  -- append-only (ADR-003 §5) is lifted for these two statements of this
  -- transaction only, on a scratch copy that is dumped and dropped: it
  -- guards production's record, and the copy is not that record. It is back
  -- on when the block commits, and nothing changed if the block fails.
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable;
  UPDATE audit_log SET payload = NULL WHERE payload IS NOT NULL;
  UPDATE audit_log SET subject_id = 'redacted' WHERE subject_id LIKE '%@%';
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable;
  UPDATE legacy_classroom_audit_log SET payload = NULL WHERE payload IS NOT NULL;
  UPDATE legacy_classroom_audit_log SET subject_id = 'redacted' WHERE subject_id LIKE '%@%';
  DELETE FROM notifications;
  UPDATE webhook_deliveries SET payload = NULL, error = NULL WHERE payload IS NOT NULL OR error IS NOT NULL;
  UPDATE scheduled_tasks SET last_message = NULL WHERE last_message IS NOT NULL;
END $$;
