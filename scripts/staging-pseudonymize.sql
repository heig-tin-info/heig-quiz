-- What scripts/staging-refresh.sh runs in the staging database right after
-- restoring production's dump, BEFORE scripts/staging-scrub.sql (ADR-028,
-- amendment 2026-10-11; audit M9), and what
-- apps/api/src/stagingScrub.db.test.ts runs against the real migrations.
--
-- It replaces who people are, not what they did: every name, address and
-- external identifier of a person becomes a deterministic fake
-- (`student-12@example.invalid`, given name "Student", family name "12";
-- `enrollment-<n>@…` for a roster row nobody claimed; `github-user-<n>`), and
-- the free text that names people beside their content is emptied (IdP
-- claims, avatars, Teams links, audit payloads, notifications, webhook
-- payloads, roster notes, guest pseudonyms). Grades, answers, questions,
-- journals and projects stay: staging exists to run the code on data shaped
-- like production's. Free text a person wrote (an answer, a comment) is
-- kept as it is.
--
-- The keep list: the accounts that must still work on staging (the product
-- owner's, a tester's) are left untouched, with their roster rows. It is
-- the comma-separated setting `quiz.staging_keep_emails`, matched without
-- case against every address of an account; staging-refresh.sh sets it from
-- STAGING_KEEP_EMAILS, the full addresses of LOGIN_ALLOWLIST and
-- SUPER_ADMIN_EMAIL (deployment.md §8). Unset, nobody is kept. A login
-- finds its account by `oidc_sub`, which a pseudonymized account no longer
-- carries (`staging:<id>`): anyone not kept who signs in on staging gets a
-- new, empty account.
--
-- Idempotent: a second run leaves the data as the first left it. Every
-- table named here exists in production since migration 0076; one added
-- later is guarded with to_regclass, as in staging-scrub.sql.
DO $$
DECLARE
  keep text[] := array_remove(
    string_to_array(lower(regexp_replace(coalesce(current_setting('quiz.staging_keep_emails', true), ''), '\s', '', 'g')), ','),
    '');
BEGIN
  -- The people to pseudonymize, numbered per role in the order they came,
  -- with every address they are known by (the account's and user_emails').
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

  CREATE TEMP TABLE staging_addresses ON COMMIT DROP AS
  SELECT u.id AS user_id, lower(u.email) AS email FROM users u JOIN staging_people p ON p.id = u.id
  UNION
  SELECT e.user_id, lower(e.email) FROM user_emails e JOIN staging_people p ON p.id = e.user_id;

  -- Teacher grants are by address: a grant of a pseudonymized person follows
  -- them (one per person, so the role rule still finds it), any other one
  -- not kept gets an address of its own.
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
  WHERE g.id = r.id AND g.email NOT LIKE '%@example.invalid' AND lower(g.email) <> ALL (keep);

  -- The rosters: a claimed row takes its person's alias, an unclaimed one
  -- not kept an alias of its own. The teacher's note about a student goes.
  UPDATE enrollments e
  SET email = p.new_email, prenom = p.given_name, nom = p.family_name, note = NULL
  FROM staging_people p
  WHERE e.user_id = p.id;
  UPDATE enrollments e
  SET email = 'enrollment-' || r.n || '@example.invalid', prenom = 'Enrollment', nom = r.n::text, note = NULL
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM enrollments WHERE user_id IS NULL) r
  WHERE e.id = r.id AND lower(e.email) <> ALL (keep);

  -- The accounts. `staging:<id>` is a subject no identity provider issues.
  UPDATE users u
  SET email = p.new_email, given_name = p.given_name, family_name = p.family_name,
      oidc_sub = 'staging:' || u.id, swiss_edu_id = NULL, picture_url = NULL
  FROM staging_people p
  WHERE u.id = p.id;
  DELETE FROM user_emails e USING staging_people p WHERE e.user_id = p.id AND e.email <> p.new_email;
  INSERT INTO user_emails (user_id, email, source, verified)
  SELECT id, new_email, 'login', verified FROM staging_people
  ON CONFLICT DO NOTHING;
  -- The affiliations stay (`staff@heig-vd.ch` names nobody, and the role
  -- rule reads them); the raw claims (names, addresses, identifiers) go.
  UPDATE user_idp_claims c SET claims = '{}'::jsonb
  FROM staging_people p WHERE c.user_id = p.id AND c.claims <> '{}'::jsonb;
  DELETE FROM avatars a USING staging_people p WHERE a.user_id = p.id;
  -- A Teams link is a person's Teams identity, and the address staging
  -- would message them at.
  DELETE FROM teams_links t USING staging_people p WHERE t.user_id = p.id;

  -- GitHub identities (accounts and the repository seats that name them):
  -- negative ids, which GitHub never issues, and a login to match. The
  -- seats of a kept account keep theirs.
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
  -- A student repository is named after its student (`lab1-jdoe`).
  UPDATE project_repos r SET full_name = split_part(r.full_name, '/', 1) || '/repo-' || left(r.id::text, 8)
  FROM staging_people p
  WHERE r.user_id = p.id AND r.full_name IS NOT NULL
    AND r.full_name <> split_part(r.full_name, '/', 1) || '/repo-' || left(r.id::text, 8);

  -- A poll guest's chosen pseudonym may be a real name.
  UPDATE guest_participants g SET pseudonym = 'Guest ' || r.n
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM guest_participants WHERE pseudonym IS NOT NULL) r
  WHERE g.id = r.id;

  -- Free text beside the content that names people: addresses, IPs,
  -- previous subjects, names in a payload. The action and its subject stay;
  -- a subject that is an address does not. The trigger that keeps
  -- `audit_log` append-only (ADR-003 §5, migration 0096) is lifted for
  -- these two statements of this transaction only: it guards production's
  -- record, and staging's copy is not that record (ADR-028, amendment
  -- 2026-10-11). It is back on when the block commits, and nothing
  -- changed if the block fails.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_immutable' AND tgrelid = 'audit_log'::regclass) THEN
    ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable;
  END IF;
  UPDATE audit_log SET payload = NULL WHERE payload IS NOT NULL;
  UPDATE audit_log SET subject_id = 'redacted' WHERE subject_id LIKE '%@%';
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_immutable' AND tgrelid = 'audit_log'::regclass) THEN
    ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable;
  END IF;
  UPDATE legacy_classroom_audit_log SET payload = NULL WHERE payload IS NOT NULL;
  UPDATE legacy_classroom_audit_log SET subject_id = 'redacted' WHERE subject_id LIKE '%@%';
  DELETE FROM notifications;
  UPDATE webhook_deliveries SET payload = NULL WHERE payload IS NOT NULL;
END $$;
