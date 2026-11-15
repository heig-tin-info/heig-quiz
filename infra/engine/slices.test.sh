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


# The engine VM's own MemTotal (2026-11-15), and every MemTotal a "4 GB" VM
# may report, keep the lines hard-coded until then.
expect "the engine VM (3906236 kB) keeps 1792M/2048M" [ "$(codespace_memory_limits 3906236 1536)" = "1792 2048" ]
for g in 3.625 3.7 3.8 3.87; do
	expect "a $g GiB VM keeps 1792M/2048M" [ "$(limits "$g")" = "1792 2048" ]
done
expect "16 GiB: 12768M/14592M" [ "$(limits 16)" = "12768 14592" ]
expect "32 GiB: 27104M/30976M" [ "$(limits 32)" = "27104 30976" ]
expect "64 GiB: 55776M/63744M" [ "$(limits 64)" = "55776 63744" ]
expect "a smaller VM never shrinks the slice: the floor, 1792M/2048M" [ "$(limits 2)" = "1792 2048" ]
expect "3.6 GiB: the floor too" [ "$(limits 3.6)" = "1792 2048" ]
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
expect "the drop-in holds MemoryHigh" grep -qx 'MemoryHigh=12768M' "$dropin"
expect "the drop-in holds MemoryMax" grep -qx 'MemoryMax=14592M' "$dropin"
expect "the drop-in is a [Slice] section" grep -qx '\[Slice\]' "$dropin"
only_dropin() { [ "$(ls -A "$units/codespace.slice.d")" = 50-memory.conf ]; }
expect "no temporary file left" only_dropin
no_memory_line() { ! grep -qE '^Memory(High|Max)=' "$1"; }
expect "codespace.slice itself sets no memory line" no_memory_line "$units/codespace.slice"
expect "the runner slice keeps its fixed lines" \
	grep -qx 'MemoryLow=1536M' "$units/quiz-runner.slice"
expect "no warning on a 16 GiB VM" [ ! -s "$work/out" ]

printf 'MemTotal:       %s kB\n' "$(gib_kb 2)" > "$work/meminfo"
(SYSTEMD_UNIT_DIR="$units" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
expect "a small VM warns about the floor" grep -q 'floor' "$work/out"
expect "a small VM's drop-in holds the floor" grep -qx 'MemoryMax=2048M' "$dropin"

# A failed read writes nothing: neither the drop-in nor the slice files.
empty_dir() { [ -z "$(ls -A "$1")" ]; }
fresh="$work/fresh"
mkdir -p "$fresh"
: > "$work/meminfo"
(SYSTEMD_UNIT_DIR="$fresh" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
rc=$?
expect "no MemTotal: fails" [ "$rc" != 0 ]
expect "no MemTotal: nothing written" empty_dir "$fresh"
(SYSTEMD_UNIT_DIR="$fresh" MEMINFO="$work/missing" install_slices) > "$work/out" 2>&1
rc=$?
expect "no meminfo file: fails" [ "$rc" != 0 ]
expect "no meminfo file: nothing written" empty_dir "$fresh"
(SYSTEMD_UNIT_DIR="$units" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
expect "no MemTotal: the previous drop-in stays" grep -qx 'MemoryMax=2048M' "$dropin"

engine="$work/engine"
mkdir -p "$engine"
cp "$here/codespace.slice" "$engine/"
sed 's/^MemoryLow=.*/MemoryLow=1.5G/' "$here/quiz-runner.slice" > "$engine/quiz-runner.slice"
printf 'MemTotal:       %s kB\n' "$(gib_kb 16)" > "$work/meminfo"
(ENGINE_DIR="$engine" SYSTEMD_UNIT_DIR="$fresh" MEMINFO="$work/meminfo" install_slices) > "$work/out" 2>&1
rc=$?
expect "an unparsable MemoryLow fails" [ "$rc" != 0 ]
expect "an unparsable MemoryLow writes nothing" empty_dir "$fresh"


if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
