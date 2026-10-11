#!/usr/bin/env bash
# gVisor for the runner: runsc, its --oci-seccomp wrapper and the runner's own
# Podman service. Why: ADR-016 (amendment of 2026-10-11); how and the switch
# that follows: apps/runner/README.md, "gVisor". Run as root on the engine VM,
# and by the CI's runsc leg; idempotent, never run by a deploy.
#
# Pinned: gVisor release 20261005 (apt channel `20261005`, package
# runsc=20261005.0), signing key fingerprint below. Bump both together.
#
# Re-running it after the switch-over: stop quiz-runner first; the gVisor
# service is restarted only when its configuration changed.
set -euo pipefail

GVISOR_RELEASE=20261005
RUNSC_VERSION=20261005.0
GVISOR_KEY_FPR=6F1DF85E3A71C24918E727D56FC6D554E32BD943
WRAPPER=/usr/local/libexec/quiz-runner/runsc
here="$(dirname "$(readlink -f "$0")")"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-gvisor: run as root" >&2
  exit 1
fi

if [ "$(dpkg-query -W -f '${Version}' runsc 2>/dev/null || true)" != "$RUNSC_VERSION" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  key="$(mktemp)"
  trap 'rm -f "$key"' EXIT
  curl -fsSL https://gvisor.dev/archive.key -o "$key"
  fpr="$(gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [ "$fpr" != "$GVISOR_KEY_FPR" ]; then
    echo "install-gvisor: gVisor key fingerprint is '$fpr', expected $GVISOR_KEY_FPR" >&2
    exit 1
  fi
  gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg "$key"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases $GVISOR_RELEASE main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update
  apt-get install -y --allow-downgrades "runsc=$RUNSC_VERSION"
fi
runsc_bin="$(command -v runsc)"

# put <mode> <target> <source|->: installs only a changed file, and says so.
changed=0
put() {
  local mode="$1" target="$2" source="$3" tmp
  tmp="$(mktemp)"
  if [ "$source" = - ]; then cat > "$tmp"; else cp "$source" "$tmp"; fi
  if ! cmp -s "$tmp" "$target"; then
    install -D -m "$mode" "$tmp" "$target"
    changed=1
  fi
  rm -f "$tmp"
}

put 0755 "$WRAPPER" - <<EOF
#!/bin/sh
# Installed by apps/runner/deploy/install-gvisor.sh (README, gVisor).
exec $runsc_bin --oci-seccomp "\$@"
EOF
put 0644 /etc/quiz-runner/containers.conf "$here/gvisor/containers.conf"
put 0644 /etc/systemd/system/quiz-runner-podman.socket "$here/gvisor/quiz-runner-podman.socket"
put 0644 /etc/systemd/system/quiz-runner-podman.service "$here/gvisor/quiz-runner-podman.service"

systemctl daemon-reload
systemctl enable quiz-runner-podman.socket
if [ "$changed" = 1 ]; then
  # A running service keeps the configuration it started with.
  systemctl stop quiz-runner-podman.service 2>/dev/null || true
  systemctl restart quiz-runner-podman.socket
else
  systemctl start quiz-runner-podman.socket
fi

"$runsc_bin" --version
podman --remote --url unix:///run/quiz-runner-podman/podman.sock info \
  --format 'quiz-runner-podman: default runtime {{.Host.OCIRuntime.Name}}'
echo "install-gvisor: done; the switch-over is in apps/runner/README.md, Switching production to gVisor."
