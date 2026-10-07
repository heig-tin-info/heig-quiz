#!/usr/bin/env bash
# The deploy dispatcher of the engine VM, code.chevallier.io (ADR-016, M6-04
# amendment): ONE forced command for the two components it hosts, the code
# runner and the online workspace portal. root's authorized_keys pins each CI
# key to the dispatcher of ITS OWN checkout and to one scope:
#   command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
#   command="/opt/quiz-engine-staging/infra/engine/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
# A key can only deploy, never open a shell. The production checkout only
# ever moves to approved commits; the staging checkout moves to every commit
# of main. The staging key still runs that commit's scripts as root on this
# VM: the scope and the separate checkout keep it from deploying production
# BY MISTAKE, they do not contain an attacker (risk accepted by the owner,
# ADR-016, M6-04 amendment).
#
# The CI's SSH command lands in $SSH_ORIGINAL_COMMAND, matched strictly and
# never eval'd:
#   [force] <component> <instance> <sha> <token>
#       runner prod, codespace prod     the production scope
#       codespace staging                the staging scope
#   <sha> <token>
#       the runner, the form the pre-M6-04 apps/runner/deploy/deploy.sh took
#       and the one the CI still sends it.
#       TODO(M6-04 follow-up): once root's authorized_keys names this script
#       (RUNBOOK step 8), the CI sends `runner prod <sha> <token>`, and this
#       branch and the forwarder apps/runner/deploy/deploy.sh go away.
# "force" overrides the codespace prod live-session guard. The token is an
# ephemeral GHCR token, piped to `podman login`; root's auth file is under
# /run, so nothing survives a reboot.
#
# The checkout moves to the deployed sha, detached, and the component's own
# steps run from it (apps/runner/deploy/install.sh,
# apps/codespace/deploy/install.sh <instance>). Moving the checkout rewrites
# THIS file while bash still reads the old copy, so the script hands over to
# the new copy exactly once, the login done, the request in the environment.
# One deploy at a time on the VM (a lock under /run, shared by both
# checkouts: both drive the same engine, systemd and Caddy).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."
# shellcheck source=lib.sh
. infra/engine/lib.sh

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
  elif [[ "$request" =~ ^([0-9a-f]{40})[[:space:]]+([^[:space:]]+)$ ]]; then
    QUIZ_DEPLOY_COMPONENT=runner
    QUIZ_DEPLOY_INSTANCE=prod
    QUIZ_DEPLOY_SHA="${BASH_REMATCH[1]}"
    token="${BASH_REMATCH[2]}"
  else
    echo "deploy: malformed request (expected: [force] <component> <instance> <sha> <token>)" >&2
    exit 2
  fi
  export QUIZ_DEPLOY_FORCE QUIZ_DEPLOY_COMPONENT QUIZ_DEPLOY_INSTANCE QUIZ_DEPLOY_SHA
else
  # A hand-over: from a previous copy of this script, which exported the
  # request, or from the pre-M6-04 runner script (through its forwarder),
  # which exports only the sha.
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
  printf '%s' "$token" | pd login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi
unset token

target="${QUIZ_DEPLOY_SHA:-HEAD}"
before=$(git rev-parse HEAD)
git fetch --quiet origin main
# A commit from before M6-04 has no dispatcher: checking it out would leave
# this forced command pointing at nothing. A rollback that far is done by
# hand (deployment.md §5).
if ! git cat-file -e "$target:infra/engine/deploy.sh" 2>/dev/null; then
  echo "deploy: $target predates the engine dispatcher (M6-04): refused, the checkout stays at ${before:0:7}" >&2
  exit 2
fi
git checkout --quiet --detach "$target"
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND='' exec "$0" "$@"
fi

case "$QUIZ_DEPLOY_COMPONENT" in
  runner) exec apps/runner/deploy/install.sh ;;
  codespace) exec apps/codespace/deploy/install.sh "$QUIZ_DEPLOY_INSTANCE" ;;
esac
