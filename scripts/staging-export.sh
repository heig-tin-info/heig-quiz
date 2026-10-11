#!/usr/bin/env bash
# Hand a PSEUDONYMIZED copy of production's data to staging (ADR-028, update
# 2026-10-11). Run on the application VM, as `srv`, from the PRODUCTION
# checkout:
#
#   /srv/quiz/scripts/staging-export.sh                      # keep list from .env.prod
#   /srv/quiz/scripts/staging-export.sh --keep a@b,c@d       # this keep list instead
#   /srv/quiz/scripts/staging-export.sh --keep-identities    # cutover rehearsal only (below)
#
# A copy of this script run from elsewhere (before production has been
# promoted to the commit that adds it) names the checkout explicitly:
#
#   QUIZ_PROD_DIR=/srv/quiz bash /tmp/staging-export.sh
#
# Staging runs as its own account (`srvstg`), which cannot read /srv/quiz:
# staging executes every commit of main before anyone approves it, so it must
# never reach production's secrets, volumes or backups, nor its people. The
# data therefore travels one way, pushed by production into an inbox staging
# can only read (`/srv/staging-inbox`, owner srv, group srvstg, mode 2750):
#
#   quiz.dump    a pg_dump -Fc of a pseudonymized copy, taken now
#   assets.tar   the question images (content-addressed)
#
# The pseudonymization happens HERE, on production's side: the database is
# copied into a scratch database of production's own PostgreSQL
# (`staging_export`), scripts/staging-pseudonymize.sql rewrites the copy,
# and only that copy is dumped, then dropped. A dump carries live rows only,
# so no real identity reaches the inbox, staging's database or its WAL. The
# accounts of the keep list are left as they are: STAGING_KEEP_EMAILS of
# .env.prod (comma-separated addresses), or `--keep`. What is replaced and
# what is kept: the header of staging-pseudonymize.sql.
#
# `--keep-identities` exports the real copy, for the heig-classroom cutover
# rehearsal only, whose import matches people by their real addresses
# (docs/merge/10-cutover-runbook.md §1.3); it is refused unless that
# rehearsal's `hgc.dump` is already in the inbox, and its copies are deleted
# the same day (that runbook, §5.1).
#
# Then, as `srvstg`: ~/quiz-staging/scripts/staging-refresh.sh
set -euo pipefail

cd "${QUIZ_PROD_DIR:-$(dirname "$(readlink -f "$0")")/..}"
INBOX="${QUIZ_STAGING_INBOX:-/srv/staging-inbox}"
[ -d "$INBOX" ] && [ -w "$INBOX" ] || { echo "staging-export: $INBOX is not a writable directory" >&2; exit 1; }

keep="$(sed -n 's/^STAGING_KEEP_EMAILS=//p' .env.prod 2>/dev/null | tail -n 1 | tr -d "\"'")"
identities=
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep="${2:-}"; shift 2 ;;
    --keep-identities) identities=1; shift ;;
    *) echo "staging-export: unknown argument '$1' (--keep <addresses> | --keep-identities)" >&2; exit 2 ;;
  esac
done
keep="$(printf '%s' "$keep" | tr -d ' \t\r' | tr '[:upper:]' '[:lower:]')"
if [ -n "$identities" ] && [ ! -s "$INBOX/hgc.dump" ]; then
  echo "staging-export: --keep-identities serves the cutover rehearsal only: put its hgc.dump in $INBOX first (cutover runbook §1.3)" >&2
  exit 2
fi

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
PROD=(docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image)
psql_postgres=("${PROD[@]}" exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 -q)

# Written under a temporary name and renamed: staging never reads half a dump.
if [ -n "$identities" ]; then
  echo "staging-export: WARNING: --keep-identities: the copy carries production's real identities (cutover rehearsal)" >&2
  "${PROD[@]}" exec -T postgres pg_dump -Fc -U quiz quiz > "$INBOX/.quiz.dump.part"
else
  echo "staging-export: kept as they are: ${keep:-nobody}"
  # The scratch copy is dropped however the export ends.
  trap '"${psql_postgres[@]}" -c "DROP DATABASE IF EXISTS staging_export WITH (FORCE)" || true' EXIT
  "${psql_postgres[@]}" -c 'DROP DATABASE IF EXISTS staging_export WITH (FORCE)' -c 'CREATE DATABASE staging_export OWNER quiz'
  "${PROD[@]}" exec -T postgres bash -o pipefail -c \
    'pg_dump -Fc -U quiz quiz | pg_restore -U quiz -d staging_export --no-owner --role=quiz --exit-on-error'
  # The keep list as a setting psql quotes (`:'keep'`), never pasted into SQL.
  {
    echo "SELECT set_config('quiz.staging_keep_emails', :'keep', false);"
    cat scripts/staging-pseudonymize.sql
  } | "${PROD[@]}" exec -T postgres psql -U quiz -d staging_export -v ON_ERROR_STOP=1 -v keep="$keep" -q
  "${PROD[@]}" exec -T postgres pg_dump -Fc -U quiz staging_export > "$INBOX/.quiz.dump.part"
fi
chmod 640 "$INBOX/.quiz.dump.part"
mv "$INBOX/.quiz.dump.part" "$INBOX/quiz.dump"

# The images belong to the containers' `node` (a sub-uid on the host): read
# through a container, streamed out as the calling user.
docker run --rm -v "$PWD/assets:/from:ro" alpine tar -C /from -cf - . > "$INBOX/.assets.tar.part"
chmod 640 "$INBOX/.assets.tar.part"
mv "$INBOX/.assets.tar.part" "$INBOX/assets.tar"

echo "staging-export: $(du -h "$INBOX/quiz.dump" | cut -f1) dump and $(du -h "$INBOX/assets.tar" | cut -f1) of images in $INBOX"
