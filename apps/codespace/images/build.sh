#!/usr/bin/env bash
#
# Builds the student image on the engine VM, through the rootful socket:
#   apps/codespace/images/build.sh            # codespace/c-dev:4.137.0
#
# The supply-chain rule is the runner's (ADR-016, M6-04 amendment): the
# portal's own image is built by the CI and pulled by sha; the images the
# students' code runs in are built HERE, from this checkout, on purpose and
# by hand, never by a deploy and never pulled from a registry. The base and
# the code-server .deb are pinned in c-dev/Containerfile (and its README).
#
# 1.5 GB, one to two minutes on 2 vCPU; keep 3 GB free. A running session
# keeps the image it started with; a new session takes the new one.
# Replaces heig-classroom's `push.sh --rebuild-image`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${CODESPACE_IMAGE_TAG:-codespace/c-dev:4.137.0}"
PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
pd() { podman --remote --url "$PODMAN_URL" "$@"; }

df -h /var/lib/containers 2>/dev/null | tail -n 1 || true
t0=$(date +%s)
pd build -t "$TAG" "$HERE/c-dev"
echo "built $TAG in $(( $(date +%s) - t0 )) s"
echo "acceptance (47 assertions, no AppArmor flag on a host without it): $HERE/c-dev/test.sh"
