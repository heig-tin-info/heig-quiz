#!/usr/bin/env bash
# Replace the staging data with a copy of production's (ADR-028). Run on the
# application VM, as `srv`, from the staging checkout:
#
#   /srv/quiz-staging/scripts/staging-refresh.sh            # last night's dump
#   /srv/quiz-staging/scripts/staging-refresh.sh --fresh    # a dump taken now
#   /srv/quiz-staging/scripts/staging-refresh.sh <file>     # that dump
#
# Never run by a deploy: a refresh wipes whatever a test had prepared.
# The data is NOT anonymized (a decision of ADR-028): staging is closed by
# LOGIN_ALLOWLIST instead. What IS removed is every credential production
# issued -- sessions, launch tickets, API tokens, OAuth grants -- so that
# nothing minted for production opens a door here.
#
# Each refresh is also a restore test of the production dump (deploy.md §6):
# a dump that does not restore here would not restore there either.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
PROD_DIR="${QUIZ_PROD_DIR:-/srv/quiz}"

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
STAGING=(docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image)

case "${1:-}" in
  --fresh)
    # Here, not in production's backups/: that directory belongs to a
    # container's sub-uid, and this dump is staging's to throw away.
    dump="$PWD/.refresh.dump"
    trap 'rm -f "$dump"' EXIT
    (cd "$PROD_DIR" && docker compose -f compose.prod.yml --env-file .env.prod \
      exec -T postgres pg_dump -Fc -U quiz quiz) > "$dump"
    ;;
  "") dump="$(ls -1t "$PROD_DIR"/backups/quiz-*.dump | head -n1)" ;;
  *) dump="$1" ;;
esac
[ -s "$dump" ] || { echo "staging-refresh: no dump at '$dump'" >&2; exit 1; }
echo "staging-refresh: restoring $dump"

# Into a freshly recreated database, the app stopped: `pg_restore --clean`
# into an existing one fails on pg-boss's partitioned tables (deploy.md §6).
"${STAGING[@]}" stop app
"${STAGING[@]}" exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
"${STAGING[@]}" exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz \
  --exit-on-error < "$dump"
# Only the tables the dump has: a dump older than the staging code lacks the
# newest ones (launch_tickets, on 2026-09-26), which its migration will
# create empty anyway.
"${STAGING[@]}" exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE present text;
BEGIN
  SELECT string_agg(quote_ident(t), ', ') INTO present
  FROM unnest(ARRAY['sessions', 'launch_tickets', 'api_tokens', 'oauth_requests', 'oauth_grants']) AS t
  WHERE to_regclass(t) IS NOT NULL;
  IF present IS NOT NULL THEN EXECUTE 'TRUNCATE ' || present; END IF;
END $$;
SQL

# The question images, content-addressed. Both directories belong to the
# containers' `node` (a sub-uid on the host): copied through a container.
docker run --rm -v "$PROD_DIR/assets:/from:ro" -v "$PWD/assets:/to" alpine \
  sh -c 'cp -a /from/. /to/'

# The app migrates on start: a dump older than the staging code is brought
# forward here, which is exactly the migration production will run next.
"${STAGING[@]}" start app
echo "staging-refresh: done"
