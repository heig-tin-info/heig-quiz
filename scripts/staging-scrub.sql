-- What scripts/staging-refresh.sh runs in the staging database right after
-- restoring production's dump (ADR-028), and what
-- apps/api/src/stagingScrub.db.test.ts runs against the real migrations.
-- Idempotent. Only the tables the dump has: a dump older than the staging
-- code lacks the newest ones (launch_tickets, on 2026-09-26), which its
-- migration will create empty anyway.
DO $$
DECLARE present text;
BEGIN
  -- Every credential production issued: nothing minted for production opens
  -- a door here.
  SELECT string_agg(quote_ident(t), ', ') INTO present
  FROM unnest(ARRAY['sessions', 'launch_tickets', 'api_tokens', 'oauth_requests', 'oauth_grants']) AS t
  WHERE to_regclass(t) IS NOT NULL;
  IF present IS NOT NULL THEN EXECUTE 'TRUNCATE ' || present; END IF;

  -- GitHub (N-SEC-18, M2-06): staging never acts on a production
  -- installation. `installation_id` is the one column that says "installed"
  -- (its suspension means nothing without it); staging's own App re-attaches
  -- its test organization at the next setup return or healing.
  IF to_regclass('github_organizations') IS NOT NULL THEN
    UPDATE github_organizations SET installation_id = NULL, suspended_at = NULL
    WHERE installation_id IS NOT NULL OR suspended_at IS NOT NULL;
  END IF;
  -- Every project archived (F-PROJ-16): the ticker's deadlines, freezes and
  -- reviews, the sync and the reconciliation skip an archived project, and
  -- without an installation nothing else reaches GitHub. Done in SQL, it
  -- leaves the groups following (the screen's archive stops them). A tester
  -- unarchives the project under test, on the test organization.
  IF to_regclass('projects') IS NOT NULL THEN
    UPDATE projects SET archived_at = now() WHERE archived_at IS NULL;
  END IF;
END $$;
