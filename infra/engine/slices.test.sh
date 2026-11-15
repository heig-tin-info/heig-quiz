#!/usr/bin/env bash
# Tests of infra/engine/lib.sh's codespace_memory_limits and install_slices:
# the workspace slice's memory lines follow the VM's RAM, reproduce the
# 2026-10-08 values on a 4 GB VM, keep a floor, and land in a drop-in.
# No root, no systemd. Run by the CI's `checks` job, or:
#   bash infra/engine/slices.test.sh
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

# shellcheck source=lib.sh
. "$here/lib.sh"

gib_kb() { awk -v g="$1" 'BEGIN { printf "%d", g * 1024 * 1024 }'; }
limits() { codespace_memory_limits "$(gib_kb "$1")" 1536; }

# Every MemTotal a "4 GB" VM may report gives today's hard-coded lines.
for g in 3.625 3.7 3.8 3.87; do
	expect "a $g GiB VM keeps 1792M/2048M" [ "$(limits "$g")" = "1792 2048" ]
done
expect "below 3712 MiB, one step down" [ "$(limits 3.6)" = "1568 1792" ]
expect "16 GiB: 12768M/14592M" [ "$(limits 16)" = "12768 14592" ]
expect "32 GiB: 27104M/30976M" [ "$(limits 32)" = "27104 30976" ]
expect "64 GiB: 55776M/63744M" [ "$(limits 64)" = "55776 63744" ]
expect "a 2 GiB VM gets the floor, 896M/1024M" [ "$(limits 2)" = "896 1024" ]
expect "a larger runner MemoryLow leaves less" \
	[ "$(codespace_memory_limits "$(gib_kb 16)" 3072)" = "11424 13056" ]

# install_slices into a scratch unit directory, from a fake meminfo.
units="$work/units"
mkdir -p "$units"
printf 'MemTotal:       %s kB\nSwapTotal:       2097148 kB\n' "$(gib_kb 16)" > "$work/meminfo"
(SYSTEMD_UNIT_DIR="$units" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
rc=$?
dropin="$units/codespace.slice.d/50-memory.conf"
expect "install_slices exits 0" [ "$rc" = 0 ]
for f in quiz-runner.slice codespace.slice; do
	expect "$f installed" [ -f "$units/$f" ]
done
expect "the drop-in holds the computed lines" \
	grep -qx 'MemoryHigh=12768M' "$dropin"
expect "the drop-in holds MemoryMax" grep -qx 'MemoryMax=14592M' "$dropin"
expect "the drop-in is a [Slice] section" grep -qx '\[Slice\]' "$dropin"
no_memory_line() { ! grep -qE '^Memory(High|Max)=' "$1"; }
expect "codespace.slice itself sets no memory line" no_memory_line "$units/codespace.slice"
expect "the runner slice keeps its fixed lines" \
	grep -qx 'MemoryLow=1536M' "$units/quiz-runner.slice"
expect "no warning on a 16 GiB VM" [ ! -s "$work/out" ]

printf 'MemTotal:       %s kB\n' "$(gib_kb 2)" > "$work/meminfo"
(SYSTEMD_UNIT_DIR="$units" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
expect "a small VM warns about the floor" grep -q 'floor' "$work/out"
expect "a small VM's drop-in holds the floor" grep -qx 'MemoryMax=1024M' "$dropin"

: > "$work/meminfo"
(SYSTEMD_UNIT_DIR="$units" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
rc=$?
expect "no MemTotal: fails" [ "$rc" != 0 ]
expect "no MemTotal: the previous drop-in stays" grep -qx 'MemoryMax=1024M' "$dropin"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
