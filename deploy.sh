#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH key. The VM's authorized_keys
# pins this key to this script:
#   command="/opt/quiz/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
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

cd /opt/quiz

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
