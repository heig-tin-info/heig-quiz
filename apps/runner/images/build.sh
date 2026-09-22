#!/usr/bin/env bash
#
# Builds the runner images: `quiz-runner-<lang>:latest`, one per language.
#
#   images/build.sh              # c cpp python js spice  (the default five)
#   images/build.sh c python     # only those
#   images/build.sh rust         # the big one, never built by default
#
# Rootless (a development workstation) or rootful (the VM) is decided by the
# socket the runner itself uses; the build does not care. Set PODMAN_BIN or
# PODMAN_REMOTE_URL to build through a specific service:
#
#   PODMAN_REMOTE_URL=unix:///run/podman/podman.sock images/build.sh
set -euo pipefail

PREFIX="${RUNNER_IMAGE_PREFIX:-quiz-runner}"
TAG="${RUNNER_IMAGE_TAG:-latest}"
PODMAN_BIN="${PODMAN_BIN:-podman}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

podman_cmd=("$PODMAN_BIN")
if [ -n "${PODMAN_REMOTE_URL:-}" ]; then
  podman_cmd+=(--remote --url "$PODMAN_REMOTE_URL")
fi

languages=("$@")
if [ ${#languages[@]} -eq 0 ]; then
  languages=(c cpp python js spice)
fi

for lang in "${languages[@]}"; do
  dir="$HERE/$lang"
  [ -d "$dir" ] || { echo "no such language: $lang" >&2; exit 1; }
  image="${PREFIX}-${lang}:${TAG}"
  echo "== building $image"
  start=$(date +%s)
  "${podman_cmd[@]}" build -t "$image" "$dir"
  echo "   built in $(( $(date +%s) - start )) s: $("${podman_cmd[@]}" image inspect "$image" --format '{{.Size}}' | numfmt --to=iec 2>/dev/null || echo '?')"
done
