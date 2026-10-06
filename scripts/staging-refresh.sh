#!/usr/bin/env bash
# Replace the staging data with a copy of production's (ADR-028). Run on the
# application VM, as `srvstg`, from the staging checkout, AFTER production
# pushed a copy into the inbox (scripts/staging-export.sh, as `srv`):
#
#   ~/quiz-staging/scripts/staging-refresh.sh            # the inbox's copy
#   ~/quiz-staging/scripts/staging-refresh.sh <file>     # that dump (images unchanged)
#
# Staging cannot read production's directory: the copy only ever travels
# from production into /srv/staging-inbox, never the other way.
#
# Never run by a deploy: a refresh wipes whatever a test had prepared.
# The data is NOT anonymized (a decision of ADR-028): staging is closed by
# LOGIN_ALLOWLIST instead. What IS removed is every credential production
# issued -- sessions, launch tickets, API tokens, OAuth grants -- so that
# nothing minted for production opens a door here; and every GitHub
# installation and live project, so that staging's own App never acts on a
# production organization (N-SEC-18).
#
# Each refresh is also a restore test of the production dump (deploy.md §6):
# a dump that does not restore here would not restore there either.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
INBOX="${QUIZ_STAGING_INBOX:-/srv/staging-inbox}"

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
STAGING=(docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image)

dump="${1:-$INBOX/quiz.dump}"
[ -s "$dump" ] || { echo "staging-refresh: no dump at '$dump'" >&2; exit 1; }
echo "staging-refresh: restoring $dump"

# Into a freshly recreated database, the app stopped: `pg_restore --clean`
# into an existing one fails on pg-boss's partitioned tables (deploy.md §6).
"${STAGING[@]}" stop app
"${STAGING[@]}" exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
"${STAGING[@]}" exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz \
  --exit-on-error < "$dump"
# Production's credentials emptied, its GitHub installations forgotten and
# its projects archived (N-SEC-18): scripts/staging-scrub.sql, tested against
# the real migrations by apps/api/src/stagingScrub.db.test.ts.
"${STAGING[@]}" exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 < scripts/staging-scrub.sql

# The question images, content-addressed. The staging directory belongs to
# the container's `node` (a sub-uid on the host): unpacked through a container.
# A dump named on the command line leaves the images as they are.
if [ -z "${1:-}" ] && [ -s "$INBOX/assets.tar" ]; then
  docker run --rm -i -v "$PWD/assets:/to" alpine \
    sh -c 'tar -C /to -xf - && chown -R 1000:1000 /to' < "$INBOX/assets.tar"
fi

# The app migrates on start: a dump older than the staging code is brought
# forward here, which is exactly the migration production will run next.
"${STAGING[@]}" start app
echo "staging-refresh: done"
