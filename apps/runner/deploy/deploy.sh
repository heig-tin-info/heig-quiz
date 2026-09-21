#!/usr/bin/env bash
# Deploy target of the code runner on the code VM (ADR-016), the twin of the
# root deploy.sh of the quiz VM. The VM's authorized_keys pins the CI key to
# this script:
#   command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# so the CI can ONLY deploy — never open a shell, even if the key leaks.
#
# The CI passes its ephemeral GHCR token as the SSH "command"; it lands in
# $SSH_ORIGINAL_COMMAND, is piped straight to `podman login` (never eval'd),
# and expires with the job. Root's Podman auth file is under /run: nothing
# survives a reboot, and no registry credential is ever stored here.
#
# The language images are NOT touched by a deploy: they are the runner's only
# supply chain and are rebuilt on purpose with images/build.sh (deploy.md).
set -euo pipefail

cd /opt/quiz-runner

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  printf '%s' "$SSH_ORIGINAL_COMMAND" \
    | podman login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi

# `git pull` rewrites THIS file while bash is still reading the old copy, so
# a deploy that changes the deploy steps would run the previous steps. Hand
# over to the pulled copy exactly once, with the login already done.
before=$(git rev-parse HEAD)
git pull --ff-only
if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QUIZ_DEPLOY_REEXEC:-}" ]; then
  QUIZ_DEPLOY_REEXEC=1 SSH_ORIGINAL_COMMAND= exec "$0"
fi
podman pull ghcr.io/heig-tin-info/quiz-runner:latest
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
podman image prune -f >/dev/null
echo "deploy: runner done ($(git rev-parse --short HEAD))"
