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

# The `apk add` line of each Alpine language (./Containerfile). `js` is the
# one image with a file of its own (js/Containerfile).
#   c, cpp  gcc (g++) + musl-dev is the whole toolchain (musl-dev brings the C
#           headers and the startup files).
#   python  CPython alone. `pip` is deliberately absent: with no network it
#           could not install anything, and its absence removes a large attack
#           surface from a process that only runs one student file.
#   rust    rustc alone, no cargo registry. An order of magnitude larger than
#           the others (~700 MB installed): built only when named. `GET
#           /health` reports the languages whose image is present, so a
#           deployment without it simply does not offer Rust.
#   spice   ngspice alone (Alpine 3.20 ships 42), a batch simulator: the
#           `circuit` question type is graded by simulating the student's
#           schematic (ADR-019). No X, no editor.
packages() {
  case "$1" in
    c) echo "gcc musl-dev" ;;
    cpp) echo "g++ musl-dev" ;;
    python) echo "python3" ;;
    rust) echo "rust" ;;
    spice) echo "ngspice" ;;
  esac
}

languages=("$@")
if [ ${#languages[@]} -eq 0 ]; then
  languages=(c cpp python js spice)
fi

for lang in "${languages[@]}"; do
  if [ -f "$HERE/$lang/Containerfile" ]; then
    build_args=("$HERE/$lang")
  elif [ -n "$(packages "$lang")" ]; then
    build_args=(--build-arg "PACKAGES=$(packages "$lang")" -f "$HERE/Containerfile" "$HERE")
  else
    echo "no such language: $lang" >&2
    exit 1
  fi
  image="${PREFIX}-${lang}:${TAG}"
  echo "== building $image"
  start=$(date +%s)
  "${podman_cmd[@]}" build -t "$image" "${build_args[@]}"
  echo "   built in $(( $(date +%s) - start )) s: $("${podman_cmd[@]}" image inspect "$image" --format '{{.Size}}' | numfmt --to=iec 2>/dev/null || echo '?')"
done
