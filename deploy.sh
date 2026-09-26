#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH keys. The VM's authorized_keys
# pins each key to this script and to ONE environment (ADR-028):
#   command="/srv/quiz/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy
#   command="/srv/quiz-staging/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging
# so the CI can ONLY deploy — never open a shell, even if a key leaks — and
# the staging key can never touch production.
#
# The CI passes "<commit sha> <ephemeral GHCR token>" as the SSH "command";
# it lands in $SSH_ORIGINAL_COMMAND. The sha is the commit to deploy: the
# checkout moves to it and the image tagged with it is started, so
# production runs exactly the image staging ran. The token is used only to
# log in for the private-image pull, then expires with the job — no registry
# credential is ever stored on the VM. A token alone (a manual deploy)
# deploys the head of origin/main, still by its sha.
#
# NEVER build here: an on-VM build starves PostgreSQL and fills the disk.
# This only pulls a prebuilt image and restarts. The code runner is deployed
# the same way on ITS VM by apps/runner/deploy/deploy.sh (ADR-016).
set -euo pipefail

# The script's own checkout: /srv/quiz (production) or /srv/quiz-staging on
# the Hetzner VM, run as the `srv` account with rootless Docker. No path is
# hard-coded, so a root checkout with rootful Docker works the same.
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

# Staging and production deploy on the same Docker daemon: one at a time, so
# the image clean-up below never removes an image the other one just pulled.
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

# "<sha> <token>" or "<token>": matched strictly, never eval'd. The sha
# travels to the re-exec through the environment.
request="${SSH_ORIGINAL_COMMAND:-}"
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
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND= exec "$0" "$@"
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
"${COMPOSE[@]}" up -d

# Every deploy leaves a sha-tagged image behind, which a dangling-only prune
# never removes. Drop the older ones; `rmi` refuses an image a container
# still uses (the other environment's), and that refusal is expected.
docker images -q --filter "reference=ghcr.io/heig-tin-info/quiz" \
  --filter "before=ghcr.io/heig-tin-info/quiz:$tag" \
  | sort -u | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null
echo "deploy: $environment at ${tag:0:7}"
