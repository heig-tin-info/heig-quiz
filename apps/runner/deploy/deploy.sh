#!/usr/bin/env bash
# Deploy target of the code runner on the code VM (ADR-016), the twin of the
# root deploy.sh of the quiz VM. The VM's authorized_keys pins the CI key to
# this script:
#   command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# so the CI can ONLY deploy — never open a shell, even if the key leaks.
#
# The CI passes "<commit sha> <ephemeral GHCR token>" as the SSH "command";
# it lands in $SSH_ORIGINAL_COMMAND. The sha is the commit promoted to
# production (ADR-028): the checkout moves to it and the runner image tagged
# with it becomes :latest, the tag the quadlet runs. The token is piped
# straight to `podman login` (never eval'd) and expires with the job. Root's
# Podman auth file is under /run: nothing survives a reboot, and no registry
# credential is ever stored here. A token alone (a manual deploy) deploys the
# head of origin/main, still by its sha.
#
# The language images are NOT touched by a deploy: they are the runner's only
# supply chain and are rebuilt on purpose with images/build.sh (deploy.md).
set -euo pipefail

cd /opt/quiz-runner

# "<sha> <token>" or "<token>": matched strictly, never eval'd. The sha
# travels to the re-exec through the environment.
request="${SSH_ORIGINAL_COMMAND:-}"
token="$request"
if [[ "$request" =~ ^([0-9a-f]{40})[[:space:]]+(.+)$ ]]; then
  export QUIZ_DEPLOY_SHA="${BASH_REMATCH[1]}"
  token="${BASH_REMATCH[2]}"
fi
if [ -n "$token" ]; then
  printf '%s' "$token" | podman login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi

# The checkout moves to the commit being deployed, detached, which rewrites
# THIS file while bash is still reading the old copy: a deploy that changes
# the deploy steps would run the previous steps. Hand over to the new copy
# exactly once, with the login already done.
before=$(git rev-parse HEAD)
git fetch --quiet origin main
git checkout --quiet --detach "${QUIZ_DEPLOY_SHA:-origin/main}"
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND= exec "$0"
fi
# The quadlet runs :latest with Pull=never; :latest is made to be the
# deployed sha here, never by the registry's moving tag.
tag="$(git rev-parse HEAD)"
podman pull "ghcr.io/heig-tin-info/quiz-runner:$tag"
podman tag "ghcr.io/heig-tin-info/quiz-runner:$tag" ghcr.io/heig-tin-info/quiz-runner:latest
# The profile the sandbox containers run under: a HOST path, because the
# Podman server is what opens it (quiz-runner.container mounts the same path
# into the service so that its startup check sees the same file).
install -m 0644 apps/runner/infra/seccomp/runner.json /etc/quiz-runner/seccomp.json
install -m 0644 apps/runner/deploy/quiz-runner.container /etc/containers/systemd/quiz-runner.container
install -m 0644 apps/runner/deploy/Caddyfile /etc/caddy/conf.d/quiz-runner.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl daemon-reload
systemctl restart quiz-runner.service
systemctl reload caddy
# Older sha-tagged images are not dangling: drop them explicitly.
podman images -q --filter "reference=ghcr.io/heig-tin-info/quiz-runner" \
  --filter "before=ghcr.io/heig-tin-info/quiz-runner:$tag" \
  | sort -u | xargs -r podman rmi >/dev/null 2>&1 || true
podman image prune -f >/dev/null
echo "deploy: runner at ${tag:0:7}"
