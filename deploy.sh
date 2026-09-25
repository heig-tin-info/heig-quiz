#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH key. The VM's authorized_keys
# pins this key to this script:
#   command="/srv/quiz/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# so the runner can ONLY deploy — never open a shell, even if the key leaks.
#
# The runner passes its ephemeral GHCR token as the SSH "command"; it lands in
# $SSH_ORIGINAL_COMMAND and is used only to log in for the private-image pull,
# then expires with the job — no registry credential is ever stored on the VM.
#
# NEVER build here: an on-VM build starves PostgreSQL and fills the disk.
# This only pulls a prebuilt image and restarts. The code runner is deployed
# the same way on ITS VM by apps/runner/deploy/deploy.sh (ADR-016).
set -euo pipefail

# The script's own checkout: /srv/quiz on the Hetzner VM, run as the `srv`
# account with rootless Docker. No path is hard-coded, so a root checkout
# with rootful Docker works the same.
cd "$(dirname "$(readlink -f "$0")")"

# Rootless Docker listens on a per-user socket; a forced-command SSH session
# does not always load the profile that exports it.
if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi

# The registry login lives in a throwaway directory, never in the shared
# ~/.docker/config.json: heig-classroom deploys on the same account, and a
# concurrent deploy's login (a token scoped to ITS package) overwrote ours
# between login and pull -- "denied" on 2026-09-25. The re-exec below keeps
# the directory (inherited through DOCKER_CONFIG) and removes it on exit.
# A re-exec by an OLDER deploy.sh inherits no DOCKER_CONFIG: that script
# already logged in to ~/.docker and cleared the token, so the pulled copy
# pulls with that login and logs in nowhere -- the trap must not trip
# `set -u` over the unset variable ("unbound variable" after a good deploy).
if [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
fi
trap '[ -z "${DOCKER_CONFIG:-}" ] || rm -rf "$DOCKER_CONFIG"' EXIT

# Optional GHCR login (private package): the token comes in over SSH, is piped
# straight to docker login's stdin (never eval'd), and is discarded after.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  printf '%s' "$SSH_ORIGINAL_COMMAND" \
    | docker login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi

# `git pull` rewrites THIS file while bash is still reading the old copy, so
# a deploy that changes the deploy steps would run the previous steps. Hand
# over to the pulled copy exactly once, with the login already done.
before=$(git rev-parse HEAD)
git pull --ff-only
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND= exec "$0"
fi
# `pull app`, not `pull`: postgres and backup are public images that compose
# already has, and naming ours keeps the login scoped to what the token was
# issued for. `--ignore-pull-failures` is deliberately NOT used: a missing
# image must stop the deploy, not half-restart the stack.
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
docker image prune -f
echo "deploy: done ($(git rev-parse --short HEAD))"
