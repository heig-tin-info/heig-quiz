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
  -- reviews, the sync and the reconciliation skip an archived project. Its
  -- groups stopped too, at the project's level as the screen's archive
  -- stops them (`stopProjects`), and no group move left for the ticker to
  -- claim (its claim does not look at the archive). A tester unarchives the
  -- project under test, on the test organization.
  IF to_regclass('projects') IS NOT NULL THEN
    UPDATE projects
    SET archived_at = coalesce(archived_at, now()),
        groups_stopped_at = coalesce(groups_stopped_at, now()),
        group_sync_due_at = NULL
    WHERE archived_at IS NULL OR groups_stopped_at IS NULL OR group_sync_due_at IS NOT NULL;
  END IF;
  -- Production's deliveries are not replayed here (`reconcile.deliveries`).
  IF to_regclass('webhook_deliveries') IS NOT NULL THEN
    UPDATE webhook_deliveries SET processed_at = now() WHERE processed_at IS NULL;
  END IF;
END $$;

-- Production's queued jobs neither: pg-boss recreates its schema, empty, when
-- the app starts.
DROP SCHEMA IF EXISTS pgboss CASCADE;
