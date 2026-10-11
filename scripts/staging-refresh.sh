#!/usr/bin/env bash
# Replace the staging data with a copy of production's (ADR-028). Run on the
# application VM, as `srvstg`, from the staging checkout, AFTER production
# pushed a copy into the inbox (scripts/staging-export.sh, as `srv`):
#
#   ~/quiz-staging/scripts/staging-refresh.sh            # the inbox's copy
#   ~/quiz-staging/scripts/staging-refresh.sh <file>     # that dump (images unchanged)
#   ~/quiz-staging/scripts/staging-refresh.sh --keep-list   # print who would be kept, change nothing
#   ~/quiz-staging/scripts/staging-refresh.sh --keep-identities [<file>]   # no pseudonymization (below)
#
# Staging cannot read production's directory: the copy only ever travels
# from production into /srv/staging-inbox, never the other way.
#
# Never run by a deploy: a refresh wipes whatever a test had prepared.
# Once restored, and before the application starts on it, the copy is
# PSEUDONYMIZED (scripts/staging-pseudonymize.sql; ADR-028, amendment
# 2026-10-11): every person's name, address and external identifier
# becomes a fake, except the accounts of the keep list (below), so that
# staging runs main's unapproved code on production-shaped data without
# real identities. Then every credential production issued -- sessions,
# launch tickets, API and OAuth tokens, kiosk and Teams codes -- and every
# secret kept in a row -- the LLM key, kiosk credentials, poll guests'
# tokens -- is removed (scripts/staging-scrub.sql), so that nothing minted
# for production opens a door here; and every GitHub installation and live
# project, so that staging's own App never acts on a production
# organization (N-SEC-18). Staging stays closed by LOGIN_ALLOWLIST too.
#
# The keep list: STAGING_KEEP_EMAILS (the environment, else .env.staging),
# plus SUPER_ADMIN_EMAIL and the full addresses of LOGIN_ALLOWLIST (not its
# @domain entries) from .env.staging: the people who sign in to staging keep
# their accounts, their seats and their roster rows.
#
# The inbox's copy is EMPTIED once the refresh succeeded (both files
# truncated: srvstg may write them, not remove them, deployment.md §8), so a
# full copy of production waits there only between an export and the next
# refresh. A refresh that fails leaves it in place, and says so, for a retry.
# A dump named on the command line is the operator's: never touched.
#
# Each refresh is also a restore test of the production dump (docs/development/deployment.md §6):
# a dump that does not restore here would not restore there either.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
INBOX="${QUIZ_STAGING_INBOX:-/srv/staging-inbox}"

# One value of .env.staging (the last assignment wins, quotes dropped).
env_value() {
  [ -f .env.staging ] || return 0
  sed -n "s/^$1=//p" .env.staging | tail -n 1 | tr -d "\"'"
}

# The keep list, lowercase, one comma-separated line: addresses only.
keep_list() {
  local explicit="${STAGING_KEEP_EMAILS-$(env_value STAGING_KEEP_EMAILS)}"
  printf '%s,%s,%s\n' "$explicit" "$(env_value SUPER_ADMIN_EMAIL)" "$(env_value LOGIN_ALLOWLIST)" \
    | tr ',' '\n' | tr -d ' \t\r' | tr '[:upper:]' '[:lower:]' \
    | { grep -E '^[^@]+@[^@]+$' || true; } | sort -u | paste -sd, -
}

if [ "${1:-}" = --keep-list ]; then
  keep_list
  exit 0
fi

# The one exception: the heig-classroom cutover rehearsal
# (docs/merge/10-cutover-runbook.md §1.3) imports classroom's real dump into
# this copy, and its identity matching needs the real addresses and edu-ID
# identifiers. Everything else of the refresh still runs; the copies are
# deleted the same day (that runbook, §5.1).
pseudonymize=1
if [ "${1:-}" = --keep-identities ]; then
  pseudonymize=
  shift
  echo "staging-refresh: WARNING: --keep-identities: production's real identities stay in staging (cutover rehearsal only)" >&2
fi

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
STAGING=(docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image)

dump="${1:-$INBOX/quiz.dump}"
from_inbox=
[ -n "${1:-}" ] || from_inbox=1
if [ ! -s "$dump" ]; then
  echo "staging-refresh: no dump at '$dump' (a successful refresh empties the inbox: run scripts/staging-export.sh as srv first)" >&2
  exit 1
fi
keep="$(keep_list)"
echo "staging-refresh: restoring $dump; kept as they are: ${keep:-nobody}"

# A failure leaves the app stopped (or on a half-refreshed database) and
# the inbox as it was, for a retry.
trap 'echo "staging-refresh: FAILED; staging is stopped${from_inbox:+, and the inbox copy is kept in $INBOX for a retry}" >&2' ERR

# Into a freshly recreated database, the app stopped: `pg_restore --clean`
# into an existing one fails on pg-boss's partitioned tables (docs/development/deployment.md §6).
"${STAGING[@]}" stop app
"${STAGING[@]}" exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
"${STAGING[@]}" exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz \
  --exit-on-error < "$dump"
# The people pseudonymized, the keep list excepted: scripts/staging-pseudonymize.sql,
# with the list as a setting psql quotes (`:'keep'`), never pasted into SQL.
if [ -n "$pseudonymize" ]; then
  {
    echo "SELECT set_config('quiz.staging_keep_emails', :'keep', false);"
    cat scripts/staging-pseudonymize.sql
  } | "${STAGING[@]}" exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 -v keep="$keep" -q
fi
# Production's credentials and secrets emptied, its GitHub installations
# forgotten and its projects archived (N-SEC-18): scripts/staging-scrub.sql.
# Both files are tested against the real migrations by
# apps/api/src/stagingScrub.db.test.ts.
"${STAGING[@]}" exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 < scripts/staging-scrub.sql

# The question images, content-addressed. The staging directory belongs to
# the container's `node` (a sub-uid on the host): unpacked through a container.
# A dump named on the command line leaves the images as they are.
if [ -n "$from_inbox" ] && [ -s "$INBOX/assets.tar" ]; then
  docker run --rm -i -v "$PWD/assets:/to" alpine \
    sh -c 'tar -C /to -xf - && chown -R 1000:1000 /to' < "$INBOX/assets.tar"
fi

# The app migrates on start: a dump older than the staging code is brought
# forward here, which is exactly the migration production will run next.
"${STAGING[@]}" start app
trap - ERR

# The inbox's copy, consumed: emptied, so that no full copy of production
# outlives the refresh. A file exported before 2026-10-11 (mode 640) cannot
# be emptied by srvstg: said loudly, for srv to remove.
if [ -n "$from_inbox" ]; then
  for f in "$INBOX/quiz.dump" "$INBOX/assets.tar"; do
    [ -e "$f" ] || continue
    if : 2>/dev/null > "$f"; then
      echo "staging-refresh: emptied $f"
    else
      echo "staging-refresh: WARNING: could not empty $f; as srv: rm -f $f" >&2
    fi
  done
fi
echo "staging-refresh: done"
