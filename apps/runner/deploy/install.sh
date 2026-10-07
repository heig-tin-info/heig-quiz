#!/usr/bin/env bash
# The runner's deploy steps on the engine VM (ADR-016). Run by the dispatcher
# infra/engine/deploy.sh, as root, once the registry login is done and the
# checkout is at the deployed sha.
#
# The checkout's commit is the runner image tagged with it, which becomes
# :latest, the tag the quadlet runs. The language images are NOT touched by
# a deploy: they are the runner's only supply chain and are rebuilt on
# purpose with images/build.sh (deploy.md).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=../../../infra/engine/lib.sh
. infra/engine/lib.sh

image=ghcr.io/heig-tin-info/quiz-runner
tag="$(git rev-parse HEAD)"
pull_retag "$image" "$tag" latest
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
drop_old_sha_tags "$image" "$tag"
echo "deploy: runner at ${tag:0:7}"
