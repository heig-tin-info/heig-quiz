#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH keys. The VM's authorized_keys
# pins each key to this script and to ONE environment (ADR-028):
#   command="/srv/quiz/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy
#   command="/home/srvstg/quiz-staging/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging
# so the CI can ONLY deploy — never open a shell, even if a key leaks. The
# staging key lands on its own account (`srvstg`, its own rootless Docker):
# the commit it runs has not been approved yet, and that account can read
# nothing of production's.
#
# The CI passes "<commit sha> <ephemeral GHCR token>" as the SSH "command";
# it lands in $SSH_ORIGINAL_COMMAND. The sha is the commit to deploy: the
# checkout moves to it and the image tagged with it is started, so
# production runs exactly the image staging ran. The token is used only to
# log in for the private-image pull, then expires with the job — no registry
# credential is ever stored on the VM. A token alone (a manual deploy)
# deploys the head of origin/main, still by its sha.
#
# Production refuses to restart under a live evaluation (exit 3, nothing
# pulled, nothing restarted; scripts/live-evaluations.sql says what "live"
# means) unless the command starts with the word "force": "force <sha>
# <token>". The CI sends it only for the sha named by the repository
# variable DEPLOY_FORCE_SHA (docs/development/deployment.md §5, *The
# live-evaluation guard*).
#
# NEVER build here: an on-VM build starves PostgreSQL and fills the disk.
# This only pulls a prebuilt image and restarts. The code runner is deployed
# the same way on ITS VM by apps/runner/deploy/deploy.sh (ADR-016).
set -euo pipefail

# The script's own checkout: /srv/quiz (production, account `srv`) or
# /home/srvstg/quiz-staging (staging, account `srvstg`) on the Hetzner VM,
# each account with its own rootless Docker. No path is hard-coded, so a root
# checkout with rootful Docker works the same.
cd "$(dirname "$(readlink -f "$0")")"

environment="${1:-production}"
case "$environment" in
  production) COMPOSE=(docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image) ;;
  staging) COMPOSE=(docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image) ;;
  *) echo "deploy: unknown environment '$environment' (production | staging)" >&2; exit 2 ;;
esac

# Rootless Docker listens on a per-user socket; a forced-command SSH session
# does not always load the profile that exports it.
if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi

# One deploy at a time per account (the lock lives in its runtime directory),
# so the image clean-up below never removes an image a concurrent deploy on
# the same daemon just pulled. Staging and production no longer share a
# daemon; the lock still guards a manual deploy racing the CI's.
# The descriptor survives the re-exec, and so does the lock.
if [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  exec 9>"${XDG_RUNTIME_DIR:-/tmp}/quiz-deploy.lock"
  flock 9
fi

# The registry login lives in a throwaway directory, never in the shared
# ~/.docker/config.json: heig-classroom deploys on the same account, and a
# concurrent deploy's login (a token scoped to ITS package) overwrote ours
# between login and pull -- "denied" on 2026-09-25. The re-exec below keeps
# the directory (inherited through DOCKER_CONFIG) and removes it on exit.
if [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
fi
trap '[ -z "${DOCKER_CONFIG:-}" ] || rm -rf "$DOCKER_CONFIG"' EXIT

# "[force] <sha> <token>" or "[force] <token>": matched strictly, never
# eval'd. The sha and the force travel to the re-exec through the
# environment; a first run takes the force from the request and nowhere else.
request="${SSH_ORIGINAL_COMMAND:-}"
if [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_FORCE=
fi
if [[ "$request" =~ ^force[[:space:]]+(.+)$ ]]; then
  QUIZ_DEPLOY_FORCE=1
  request="${BASH_REMATCH[1]}"
fi
export QUIZ_DEPLOY_FORCE
token="$request"
if [[ "$request" =~ ^([0-9a-f]{40})[[:space:]]+(.+)$ ]]; then
  export QUIZ_DEPLOY_SHA="${BASH_REMATCH[1]}"
  token="${BASH_REMATCH[2]}"
fi

# Optional GHCR login (private package): the token is piped straight to
# docker login's stdin, and discarded after.
if [ -n "$token" ]; then
  printf '%s' "$token" | docker login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi

# The checkout moves to the commit being deployed, detached: the compose file
# and the image always come from the same commit, including when production
# is promoted to a sha main has since moved past.
# That rewrites THIS file while bash is still reading the old copy, so a
# deploy that changes the deploy steps would run the previous steps. Hand
# over to the new copy exactly once, with the login already done.
before=$(git rev-parse HEAD)
git fetch --quiet origin main
git checkout --quiet --detach "${QUIZ_DEPLOY_SHA:-origin/main}"
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND='' exec "$0" "$@"
fi

# The guard (docs/spec/05-architecture.md §5.9): production is never restarted
# under a live evaluation. scripts/live-evaluations.sql says what "live"
# means; it runs in the RUNNING database, before anything is pulled or
# restarted. On a refusal the checkout goes back to the running commit and
# the job fails, so the operator re-runs it once the room is empty, or with
# "force" (docs/development/deployment.md §5, *The live-evaluation guard*).
# Staging is not guarded: nobody sits an exam there, its data is a copy of
# production's (live rows included, frozen at the copy), and a refused
# staging deploy would hold back every promotion.
if [ "$environment" = production ] && [ -f .env.image ]; then
  # An assignment, so that a failing `ps` stops the deploy (set -e) instead
  # of reading as "no database".
  postgres=$("${COMPOSE[@]}" ps --status running -q postgres)
  live=
  # No database running, no evaluation running: nothing to guard.
  if [ -n "$postgres" ]; then
    # Fail closed: a query that cannot run refuses the deploy like a live row.
    live=$("${COMPOSE[@]}" exec -T postgres \
      psql -XAtq -v ON_ERROR_STOP=1 -F $'\t' -U quiz -d quiz < scripts/live-evaluations.sql) \
      || live="(the live-evaluation query failed: see the error above)"
  fi
  if [ -n "$live" ]; then
    {
      echo "deploy: production has a live evaluation (title | state | mode | opens | closes):"
      printf '%s\n' "$live" | sed 's/\t/ | /g; s/^/  /'
    } >&2
    if [ -z "${QUIZ_DEPLOY_FORCE:-}" ]; then
      echo "deploy: REFUSED. Re-run the deploy job once it has closed, or force it (docs/development/deployment.md §5)." >&2
      # Back to the commit actually running: .env.image names it, whichever
      # copy of this script (old or new) did the checkout.
      # Only a full sha reaches git: never an option-like value.
      running=$(sed -n 's/^IMAGE_TAG=//p' .env.image)
      if [[ "$running" =~ ^[0-9a-f]{40}$ ]]; then
        git checkout --quiet --detach "$running"
      else
        echo "deploy: warning: .env.image names no sha ('$running'), checkout left at $(git rev-parse --short HEAD)." >&2
      fi
      exit 3
    fi
    echo "deploy: FORCED, restarting anyway." >&2
  fi
fi

# The image tag is the sha, kept in .env.image so that a later manual
# `up -d` restarts THIS image, not whatever :latest has become since.
tag="$(git rev-parse HEAD)"
printf 'IMAGE_TAG=%s\n' "$tag" > .env.image

# `pull app`, not `pull`: postgres and backup are public images that compose
# already has, and naming ours keeps the login scoped to what the token was
# issued for. `--ignore-pull-failures` is deliberately NOT used: a missing
# image must stop the deploy, not half-restart the stack.
"${COMPOSE[@]}" pull app
# `--wait`: return only once every container is running and the app's
# HEALTHCHECK (/healthz) says healthy, and fail otherwise -- so the exit code
# the CI receives over SSH is the health of the deploy, production included.
"${COMPOSE[@]}" up -d --wait --wait-timeout 150

# Every deploy leaves a sha-tagged image behind, which a dangling-only prune
# never removes. Drop the older ones; `rmi` refuses an image a container
# still uses (the other environment's), and that refusal is expected.
docker images -q --filter "reference=ghcr.io/heig-tin-info/quiz" \
  --filter "before=ghcr.io/heig-tin-info/quiz:$tag" \
  | sort -u | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null
echo "deploy: $environment at ${tag:0:7}"
