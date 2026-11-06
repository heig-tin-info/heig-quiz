ALTER TABLE "users" ADD COLUMN "inactivity_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inactivity_reminded_at" timestamp with time zone;--> statement-breakpoint
-- THE per-account wipe list (ADR-117 §8, amended by the product owner on
-- 2026-11-05), run by production's pseudonymization and by
-- scripts/staging-pseudonymize.sql. What it replaces, deletes and keeps, and
-- why it writes several modules' tables: apps/api/src/modules/account/service.ts.
-- Idempotent: a second call with the same arguments changes nothing.
CREATE FUNCTION "quiz_pseudonymize_account"(
  p_user uuid,
  p_subject_prefix text,
  p_email text,
  p_given_name text,
  p_family_name text,
  p_anonymize boolean
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  addresses text[];
  was_verified boolean;
  first_grant uuid;
  old_id bigint;
  new_id bigint;
BEGIN
  SELECT array_agg(DISTINCT a.email) INTO addresses FROM (
    SELECT lower(u.email) AS email FROM users u WHERE u.id = p_user
    UNION SELECT lower(e.email) FROM user_emails e WHERE e.user_id = p_user
  ) a;
  IF addresses IS NULL THEN
    RAISE EXCEPTION 'quiz_pseudonymize_account: no account %', p_user USING ERRCODE = 'no_data_found';
  END IF;
  SELECT u.email_verified OR EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.verified)
  INTO was_verified FROM users u WHERE u.id = p_user;

  -- The teacher grant: one, under the new address, so the role rule still
  -- reads it; any other the person held under another address goes.
  SELECT g.id INTO first_grant FROM teacher_grants g
  WHERE lower(g.email) = ANY (addresses) ORDER BY g.created_at, g.id LIMIT 1;
  IF first_grant IS NOT NULL THEN
    DELETE FROM teacher_grants g WHERE lower(g.email) = ANY (addresses) AND g.id <> first_grant;
    UPDATE teacher_grants SET email = p_email WHERE id = first_grant AND email <> p_email;
  END IF;

  -- The roster lines it claimed lose its names and address too, else a
  -- re-imported line or a login under that address re-claims the seat.
  UPDATE enrollments SET email = p_email, prenom = p_given_name, nom = p_family_name, note = NULL
  WHERE user_id = p_user
    AND (email, prenom, nom, note) IS DISTINCT FROM (p_email, p_given_name, p_family_name, NULL::text);

  UPDATE users
  SET email = p_email, given_name = p_given_name, family_name = p_family_name,
      oidc_sub = p_subject_prefix || p_user::text, swiss_edu_id = NULL, picture_url = NULL,
      notification_email = NULL,
      anonymized_at = CASE WHEN p_anonymize THEN coalesce(anonymized_at, now()) ELSE anonymized_at END
  WHERE id = p_user;
  DELETE FROM user_emails WHERE user_id = p_user AND email <> p_email;
  INSERT INTO user_emails (user_id, email, source, verified)
  VALUES (p_user, p_email, 'login', was_verified)
  ON CONFLICT DO NOTHING;
  UPDATE user_idp_claims SET claims = '{}'::jsonb WHERE user_id = p_user AND claims <> '{}'::jsonb;
  DELETE FROM avatars WHERE user_id = p_user;
  -- A Teams link is a person's Teams identity, and an address to message.
  DELETE FROM teams_link_tokens t USING teams_links l
  WHERE l.user_id = p_user AND t.tenant_id = l.tenant_id AND t.aad_object_id = l.aad_object_id;
  DELETE FROM teams_links WHERE user_id = p_user;

  -- GitHub identities, one negative id each, below every id in use. One
  -- linked to another account is that account's, and stays. On staging the
  -- copy-wide renumbering runs first, so this loop finds nothing there.
  FOR old_id IN
    SELECT DISTINCT ids.id FROM (
      SELECT a.github_user_id AS id FROM github_accounts a WHERE a.user_id = p_user
      UNION ALL
      SELECT r.github_user_id FROM project_repo_access r
      JOIN enrollments e ON e.id = r.enrollment_id WHERE e.user_id = p_user
    ) ids
    WHERE ids.id > 0
      AND NOT EXISTS (SELECT 1 FROM github_accounts o WHERE o.github_user_id = ids.id AND o.user_id <> p_user)
    ORDER BY ids.id
  LOOP
    SELECT least(0, coalesce(min(all_ids.id), 0)) - 1 INTO new_id FROM (
      SELECT github_user_id AS id FROM github_accounts UNION ALL SELECT github_user_id FROM project_repo_access
    ) all_ids;
    UPDATE github_accounts SET github_user_id = new_id, login = 'github-user-' || -new_id WHERE github_user_id = old_id;
    UPDATE project_repo_access SET github_user_id = new_id, github_login = 'github-user-' || -new_id
    WHERE github_user_id = old_id;
  END LOOP;

  -- Every credential: nothing issued to the person opens a door any more.
  DELETE FROM sessions WHERE user_id = p_user OR actor_user_id = p_user;
  DELETE FROM launch_tickets WHERE user_id = p_user OR actor_user_id = p_user;
  DELETE FROM api_tokens WHERE user_id = p_user;
  DELETE FROM oauth_grants WHERE user_id = p_user;
  DELETE FROM oauth_requests WHERE user_id = p_user;
  DELETE FROM kiosk_pairings WHERE user_id = p_user AND state IN ('pending', 'approved');
  DELETE FROM notifications WHERE user_id = p_user;

  IF p_anonymize THEN
    DELETE FROM presence_hours WHERE user_id = p_user;
    DELETE FROM presence_last_seen WHERE user_id = p_user;
    DELETE FROM notification_preferences WHERE user_id = p_user;
    DELETE FROM user_course_prefs WHERE user_id = p_user;
  END IF;
END;
$$;
