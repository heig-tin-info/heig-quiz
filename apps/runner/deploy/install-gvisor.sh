#!/usr/bin/env bash
# gVisor for the runner (N-SEC-06, ADR-016 amendment of 2026-10-11). Run as
# root on the engine VM — and by the CI's runsc leg
# (.github/workflows/runner-integration.yml), so what production gets is what
# the integration suite proved. Idempotent. A deploy never runs it, and it does
# not switch the runner over: the operator does that afterwards
# (gvisor/quiz-runner.container.d-gvisor.conf, apps/runner/README.md).
#
# What it installs:
#   1. the `runsc` package, from gVisor's own apt repository;
#   2. /usr/local/libexec/quiz-runner/runsc, which runs runsc with
#      `--oci-seccomp`: without it runsc IGNORES the OCI seccomp profile, and
#      the runner's profile (invariant 12) would be configured, not applied;
#   3. a Podman service of the runner's own, quiz-runner-podman.socket on
#      /run/quiz-runner-podman/podman.sock, whose DEFAULT runtime is that
#      wrapper (/etc/quiz-runner/containers.conf). A `--remote` client cannot
#      choose the runtime of a container, and the system socket also serves
#      the workspace portal, which keeps its runtime.
set -euo pipefail

here="$(dirname "$(readlink -f "$0")")"
WRAPPER=/usr/local/libexec/quiz-runner/runsc

if [ "$(id -u)" -ne 0 ]; then
  echo "install-gvisor: run as root" >&2
  exit 1
fi

if ! command -v runsc >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  curl -fsSL https://gvisor.dev/archive.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update
  apt-get install -y runsc
fi
runsc_bin="$(command -v runsc)"

install -d -m 0755 "$(dirname "$WRAPPER")"
cat > "$WRAPPER" <<EOF
#!/bin/sh
# Installed by apps/runner/deploy/install-gvisor.sh. --oci-seccomp: apply the
# OCI spec's seccomp profile inside the sandbox, which runsc otherwise ignores.
exec $runsc_bin --oci-seccomp "\$@"
EOF
chmod 0755 "$WRAPPER"

install -d -m 0755 /etc/quiz-runner
install -m 0644 "$here/gvisor/containers.conf" /etc/quiz-runner/containers.conf
install -m 0644 "$here/gvisor/quiz-runner-podman.socket" /etc/systemd/system/quiz-runner-podman.socket
install -m 0644 "$here/gvisor/quiz-runner-podman.service" /etc/systemd/system/quiz-runner-podman.service
systemctl daemon-reload
systemctl enable quiz-runner-podman.socket
# A running service keeps the configuration it started with.
systemctl stop quiz-runner-podman.service 2>/dev/null || true
systemctl restart quiz-runner-podman.socket

"$runsc_bin" --version
podman --remote --url unix:///run/quiz-runner-podman/podman.sock info --format 'quiz-runner-podman: default runtime {{.Host.OCIRuntime.Name}}'
cat <<'EOF'
install-gvisor: done. To switch the runner over (apps/runner/README.md):
  install -D -m 0644 apps/runner/deploy/gvisor/quiz-runner.container.d-gvisor.conf \
    /etc/containers/systemd/quiz-runner.container.d/gvisor.conf
  # in /etc/quiz-runner/env:
  #   PODMAN_SOCKET=/run/quiz-runner-podman/podman.sock
  #   RUNNER_RUNTIME=runsc
  systemctl daemon-reload && systemctl restart quiz-runner
EOF
