#!/usr/bin/env bash
# The deploy dispatcher of the engine VM, code.chevallier.io (ADR-016, M6-04
# amendment): ONE forced command for the two components it hosts, the code
# runner and the online workspace portal. root's authorized_keys pins each CI
# key to this script and to ONE scope:
#   command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
#   command="/opt/quiz-runner/infra/engine/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
# so a key can ONLY deploy what its scope allows, never open a shell.
#
# The CI's SSH command lands in $SSH_ORIGINAL_COMMAND, matched strictly and
# never eval'd:
#   [force] <component> <instance> <sha> <token>
#       runner prod        the production scope
#       codespace prod     the production scope; "force" overrides the
#                          live-session guard (apps/codespace/deploy/install.sh)
#       codespace staging  the staging scope
#   <sha> <token> | <token>
#       the runner, as the runner's own deploy.sh accepted it before M6-04
#       (a token alone deploys the head of origin/main, still by its sha)
# The token is an ephemeral GHCR token, piped to `podman login`; root's
# Podman auth file is under /run, so nothing survives a reboot.
#
# The checkout (/opt/quiz-runner) moves to the deployed sha, detached, and the
# component's own steps run from it: apps/runner/deploy/install.sh,
# apps/codespace/deploy/install.sh <instance>. Moving the checkout rewrites
# THIS file while bash still reads the old copy, so the script hands over to
# the new copy exactly once, the login done, the request in the environment.
# One deploy at a time on the VM (a lock under /run): staging's and
# production's jobs may overlap, and each moves the checkout to ITS sha.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."

scope="${1:-}"
case "$scope" in
  production | staging) ;;
  *) echo "deploy: unknown scope '$scope' (production | staging)" >&2; exit 2 ;;
esac

# The descriptor survives the re-exec, and so does the lock.
if [ -z "${QUIZ_DEPLOY_LOCKED:-}" ]; then
  exec 9>/run/quiz-engine-deploy.lock
  if ! flock -w 900 9; then
    echo "deploy: another deploy has held the engine VM for 15 minutes" >&2
    exit 4
  fi
  export QUIZ_DEPLOY_LOCKED=1
fi

token=
if [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  request="${SSH_ORIGINAL_COMMAND:-}"
  QUIZ_DEPLOY_FORCE=
  if [[ "$request" =~ ^force[[:space:]]+(.+)$ ]]; then
    QUIZ_DEPLOY_FORCE=1
    request="${BASH_REMATCH[1]}"
  fi
  if [[ "$request" =~ ^(runner|codespace)[[:space:]]+([a-z]+)[[:space:]]+([0-9a-f]{40})[[:space:]]+([^[:space:]]+)$ ]]; then
    QUIZ_DEPLOY_COMPONENT="${BASH_REMATCH[1]}"
    QUIZ_DEPLOY_INSTANCE="${BASH_REMATCH[2]}"
    QUIZ_DEPLOY_SHA="${BASH_REMATCH[3]}"
    token="${BASH_REMATCH[4]}"
  elif [[ "$request" =~ ^([0-9a-f]{40})[[:space:]]+(.+)$ ]]; then
    QUIZ_DEPLOY_COMPONENT=runner
    QUIZ_DEPLOY_INSTANCE=prod
    QUIZ_DEPLOY_SHA="${BASH_REMATCH[1]}"
    token="${BASH_REMATCH[2]}"
  elif [[ "$request" =~ ^[^[:space:]]*$ ]]; then
    QUIZ_DEPLOY_COMPONENT=runner
    QUIZ_DEPLOY_INSTANCE=prod
    token="$request"
  else
    echo "deploy: malformed request (expected: [force] <component> <instance> <sha> <token>)" >&2
    exit 2
  fi
  export QUIZ_DEPLOY_FORCE QUIZ_DEPLOY_COMPONENT QUIZ_DEPLOY_INSTANCE
  if [ -n "${QUIZ_DEPLOY_SHA:-}" ]; then export QUIZ_DEPLOY_SHA; fi
else
  # A hand-over: from a previous copy of this script, which exported the
  # request, or from the runner's deploy.sh of before M6-04 (through its
  # forwarder), which knows only the runner and exports only the sha.
  QUIZ_DEPLOY_COMPONENT="${QUIZ_DEPLOY_COMPONENT:-runner}"
  QUIZ_DEPLOY_INSTANCE="${QUIZ_DEPLOY_INSTANCE:-prod}"
  export QUIZ_DEPLOY_COMPONENT QUIZ_DEPLOY_INSTANCE
fi

# What each key may deploy. Checked before the login, and again by the copy
# a hand-over reaches.
case "$scope:$QUIZ_DEPLOY_COMPONENT:$QUIZ_DEPLOY_INSTANCE" in
  production:runner:prod | production:codespace:prod | staging:codespace:staging) ;;
  *)
    echo "deploy: the $scope key may not deploy '$QUIZ_DEPLOY_COMPONENT $QUIZ_DEPLOY_INSTANCE'" >&2
    exit 2
    ;;
esac

if [ -n "$token" ]; then
  printf '%s' "$token" | podman login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi
unset token

before=$(git rev-parse HEAD)
git fetch --quiet origin main
git checkout --quiet --detach "${QUIZ_DEPLOY_SHA:-origin/main}"
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND='' exec "$0" "$@"
fi

case "$QUIZ_DEPLOY_COMPONENT" in
  runner) exec apps/runner/deploy/install.sh ;;
  codespace) exec apps/codespace/deploy/install.sh "$QUIZ_DEPLOY_INSTANCE" ;;
esac
