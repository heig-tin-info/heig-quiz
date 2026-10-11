-- What scripts/staging-refresh.sh runs in the staging database right after
-- restoring production's dump, pseudonymized before it left production
-- (scripts/staging-pseudonymize.sql; ADR-028), and what
-- apps/api/src/stagingScrub.db.test.ts runs against the real migrations.
-- Secrets that live outside the database (the App key, the webhook and
-- cookie secrets, the edu-ID key, the Teams client) are in .env.staging and
-- secrets/, set up once (deployment.md §8), and never copied by a refresh.
-- Idempotent. Only the tables the dump has: a dump older than the staging
-- code lacks the newest ones (launch_tickets, on 2026-09-26), which its
-- migration will create empty anyway.
DO $$
DECLARE present text;
BEGIN
  -- Every credential production issued: nothing minted for production opens
  -- a door here. Sessions, launch tickets, personal and OAuth tokens, the
  -- codes of a kiosk pairing in progress, and the one-time links that tie a
  -- Teams account (audit L17).
  SELECT string_agg(quote_ident(t), ', ') INTO present
  FROM unnest(ARRAY['sessions', 'launch_tickets', 'api_tokens', 'oauth_requests', 'oauth_grants',
                    'kiosk_pairings', 'teams_link_tokens']) AS t
  WHERE to_regclass(t) IS NOT NULL;
  IF present IS NOT NULL THEN EXECUTE 'TRUNCATE ' || present; END IF;

  -- The secrets kept in rows that must stay (audit L17). The LLM provider's
  -- key, encrypted under a key staging may share: staging's administrator
  -- enters a key of staging's own (the settings, models and cap stay). A
  -- kiosk station's credential: the station attests again before it opens
  -- anything here. A poll guest's bearer token: replaced by the hash of a
  -- value nobody holds (the column is required and unique), so the guest's
  -- attempt stays and no production link reopens it.
  IF to_regclass('llm_settings') IS NOT NULL THEN
    UPDATE llm_settings SET key_ciphertext = NULL, key_last4 = NULL
    WHERE key_ciphertext IS NOT NULL OR key_last4 IS NOT NULL;
  END IF;
  IF to_regclass('kiosk_devices') IS NOT NULL THEN
    UPDATE kiosk_devices SET credential_hash = NULL WHERE credential_hash IS NOT NULL;
  END IF;
  IF to_regclass('guest_participants') IS NOT NULL THEN
    UPDATE guest_participants
    SET token_hash = encode(sha256(convert_to(gen_random_uuid()::text || id::text, 'UTF8')), 'hex');
  END IF;

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
