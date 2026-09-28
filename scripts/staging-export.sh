#!/usr/bin/env bash
# Hand a copy of production's data to staging (ADR-028). Run on the
# application VM, as `srv`, from the PRODUCTION checkout:
#
#   /srv/quiz/scripts/staging-export.sh
#
# Staging runs as its own account (`srvstg`), which cannot read /srv/quiz:
# staging executes every commit of main before anyone approves it, so it must
# never reach production's secrets, volumes or backups. The data therefore
# travels one way, pushed by production into an inbox staging can only read
# (`/srv/staging-inbox`, owner srv, group srvstg, mode 2750):
#
#   quiz.dump    a pg_dump -Fc taken now
#   assets.tar   the question images (content-addressed)
#
# Then, as `srvstg`: ~/quiz-staging/scripts/staging-refresh.sh
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
INBOX="${QUIZ_STAGING_INBOX:-/srv/staging-inbox}"
[ -d "$INBOX" ] && [ -w "$INBOX" ] || { echo "staging-export: $INBOX is not a writable directory" >&2; exit 1; }

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
PROD=(docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image)

# Written under a temporary name and renamed: staging never reads half a dump.
"${PROD[@]}" exec -T postgres pg_dump -Fc -U quiz quiz > "$INBOX/.quiz.dump.part"
mv "$INBOX/.quiz.dump.part" "$INBOX/quiz.dump"

# The images belong to the containers' `node` (a sub-uid on the host): read
# through a container, streamed out as the calling user.
docker run --rm -v "$PWD/assets:/from:ro" alpine tar -C /from -cf - . > "$INBOX/.assets.tar.part"
mv "$INBOX/.assets.tar.part" "$INBOX/assets.tar"

chmod 640 "$INBOX/quiz.dump" "$INBOX/assets.tar"
echo "staging-export: $(du -h "$INBOX/quiz.dump" | cut -f1) dump and $(du -h "$INBOX/assets.tar" | cut -f1) of images in $INBOX"
