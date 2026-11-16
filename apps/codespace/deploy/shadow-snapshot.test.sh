#!/usr/bin/env bash
# Tests of shadow-snapshot.sh, the root timer's snapshot: one volume whose
# snapshot blocks (a nested repository whose HEAD is a FIFO, which git opens
# when it probes it) is timed out and skipped, the other volumes are still
# snapshotted, and the script ends. No root, no systemd. Run by the CI's
# `checks` job, or:
#   bash apps/codespace/deploy/shadow-snapshot.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
expect() {
	local name="$1"
	shift
	if "$@"; then
		printf 'ok    %s\n' "$name"
	else
		printf 'FAIL  %s\n' "$name" >&2
		failures=$((failures + 1))
	fi
}

volumes="$work/volumes"
# A volume whose `git add -A` blocks: git probes sub/.git as a nested
# repository and opens its HEAD, a FIFO no one writes.
stuck="$volumes/alice/lab1/work"
mkdir -p "$stuck/sub/.git/objects" "$stuck/sub/.git/refs"
mkfifo "$stuck/sub/.git/HEAD"
printf 'a\n' > "$stuck/a.c"
# Two ordinary volumes, one before and one after it in the walk.
for v in aaron/lab1 bob/lab1; do
	mkdir -p "$volumes/$v/work"
	printf 'int main;\n' > "$volumes/$v/work/main.c"
done

started=$(date +%s)
CODESPACE_VOLUMES="$volumes" SHADOW_VOLUME_TIMEOUT=2 timeout 60 bash "$here/shadow-snapshot.sh" > "$work/out" 2> "$work/err"
rc=$?
elapsed=$(( $(date +%s) - started ))

expect "the script ends, exit 0" [ "$rc" = 0 ]
expect "within the per-volume bound, not the outer one ($elapsed s)" [ "$elapsed" -lt 30 ]
expect "the stuck volume is logged as timed out" grep -q "alice/lab1 timed out" "$work/err"
expect "the summary counts it" grep -q "2 snapshots, 0 unchanged, 0 failed, 1 timed out" "$work/out"
committed() { git --git-dir="$volumes/$1/shadow.git" rev-parse --verify -q HEAD >/dev/null; }
expect "the volume before it is snapshotted" committed aaron/lab1
expect "the volume after it is snapshotted" committed bob/lab1
expect "the stuck volume left no index lock" [ ! -e "$volumes/alice/lab1/shadow.git/index.lock" ]

if [ "$failures" -gt 0 ]; then
	printf '%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf 'all passed\n'
