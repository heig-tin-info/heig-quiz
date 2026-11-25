# Shared by the three acceptance tests of the image (README § Testing):
#   test.sh            the contract: what the portal relies on, and the
#                      contract check (contract/check) run against the image
#   test-hardening.sh  the session's hardening seen from inside: seccomp,
#                      AppArmor, read-only root, user namespace, pids limit
#   test-toolchain.sh  what a C or C++ lab uses: gcc, g++, gdb, clangd,
#                      Baygon, pytest, the debugger's terminal
# Sourced, not executed. Each test takes the image as its first argument (or
# IMAGE=), localhost/quiz-base:dev (build.sh's) by default, starts its
# own containers through run-hardened.sh and removes them on exit.
#
# Prerequisites: rootful Podman reachable on unix:///run/podman/podman.sock,
# the image built or pulled, python3 on the host, and the `codespace`
# AppArmor profile loaded (`sudo apparmor_parser -r /etc/apparmor.d/codespace`,
# see infra/apparmor/codespace). On a host WITHOUT AppArmor — the WSL2
# development workstation — run with `APPARMOR=` (empty): `podman run`
# refuses a profile name the kernel does not know, and the hardening test
# then skips the label check with a note.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the values are read by the scripts that source this file
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
IMAGE="${1:-${IMAGE:-localhost/quiz-base:dev}}"
PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"

# The containers a test started, removed on exit; container A is the one
# cexec runs in. SUITE names them, so two tests never share a name.
SUITE="${SUITE:?the test sets SUITE before sourcing test-lib.sh}"
CTR_A="qb-${SUITE}-a"
CONTAINERS=()
VOL_BASE="$(mktemp -d /tmp/quiz-base-test-XXXXXX)"
mkdir -p "${VOL_BASE}/a/work"

podman_remote() { podman --remote --url "$PODMAN_URL" "$@"; }
# Runs a bash command inside container A, as the student user.
cexec() { podman_remote exec "$CTR_A" bash -lc "$1"; }

NTEST=0
ok()   { NTEST=$((NTEST+1)); printf '  ok   %s\n' "$1"; }
fail() { printf '\nFAIL: %s\n' "$1" >&2; [ $# -gt 1 ] && printf '  --- context ---\n%s\n' "$2" >&2; cleanup; exit 1; }
head2() { printf '\n== %s\n' "$1"; }
passed() { printf '\n%s: %d assertions, all green.\n' "$SUITE" "$NTEST"; }

cleanup() {
  [ ${#CONTAINERS[@]} -eq 0 ] || podman_remote rm -f "${CONTAINERS[@]}" >/dev/null 2>&1
  rm -rf "$VOL_BASE" 2>/dev/null
}
trap 'cleanup' EXIT

# The variables the portal sets on `podman run` for a session outside SEB
# (sessions/manager.ts, CONTAINER_ENV_KEYS): three CODESPACE_ for the
# status-bar extension, four GIT_ for the student's identity; a SEB session
# swaps CODESPACE_RETURN_URL for CODESPACE_SEB, seven still. No spaces:
# run-hardened.sh splits EXTRA_ARGS with the shell (the portal passes each
# value as one argv element, with no shell).
ENV_DEADLINE=2026-10-01T12:00:00.000Z
ENV_RETURN_URL=https://classroom.chevallier.io/
ENV_ASSIGNMENT_NAME=TP3-pointeurs
ENV_GIT_NAME=Alex-Dupuis
ENV_GIT_EMAIL=alex.dupuis@heig-vd.ch
PORTAL_ENV="-e CODESPACE_DEADLINE=${ENV_DEADLINE} -e CODESPACE_RETURN_URL=${ENV_RETURN_URL} -e CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_AUTHOR_NAME=${ENV_GIT_NAME} -e GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_COMMITTER_NAME=${ENV_GIT_NAME} -e GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"

# start <name> <letter> [<extra podman options>] [<image>]: the image (the
# one under test by default) under run-hardened.sh, its work directory
# ${VOL_BASE}/<letter>/work (written before the start: the `:U` mount
# rechowns it onto the container's UID).
start() {
  mkdir -p "${VOL_BASE}/$2/work"
  CONTAINERS+=("$1")
  CTR_NAME="$1" VOL_DIR="${VOL_BASE}/$2" IMAGE="${4:-$IMAGE}" EXTRA_ARGS="${3:-}" \
    "${HERE}/run-hardened.sh" >/dev/null \
    || fail "run-hardened.sh did not start $1"
}

# wait_healthz <name>: until code-server answers /healthz (30 s at most);
# HEALTH holds its answer.
wait_healthz() {
  HEALTH=""
  for _ in $(seq 1 300); do
    HEALTH=$(podman_remote exec "$1" curl -sS -m 2 -w ' HTTP=%{http_code}' http://localhost:8080/healthz 2>/dev/null)
    case "$HEALTH" in *"HTTP=200"*) return 0 ;; esac
    HEALTH=""
    sleep 0.1
  done
  fail "$1: /healthz did not answer 200 within 30 s" "$(podman_remote logs "$1" 2>&1 | tail -30)"
}

# The status-bar extension's directory in container A (its version is the
# image's, not necessarily this checkout's Containerfile's).
statusbar_dir() {
  cexec 'ls -d /opt/code-server/extensions/heig.codespace-statusbar-*' 2>/dev/null | head -n 1 | tr -d '\r'
}

printf '%s: %s\n' "$SUITE" "$IMAGE"
