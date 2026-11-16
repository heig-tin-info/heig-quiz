#!/usr/bin/env bash
# Tests of shadow-snapshot.sh, the root timer's snapshot, against real
# repositories in a temporary directory (audit L23, apps/codespace/CLAUDE.md
# invariant 13): a nested `.git` of any kind — a repository directory, a
# gitfile pointing at another repository on the host, a symbolic link — at
# depth 1 and deeper is never opened, no gitlink is recorded, the ordinary
# files beside it are captured. The same cases as src/sessions/shadow.test.ts.
#
# The proof is a trap: a repository whose HEAD is a FIFO. git's probe of an
# embedded repository opens HEAD, and that open blocks until a writer comes;
# the watch loop below finds such a blocked reader (`: > fifo` returns at once
# only then), counts it and so releases it. No root, no Podman. Run by the
# CI's `checks` job, or:
#   bash apps/codespace/deploy/shadow-snapshot.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'chmod -R u+rwX "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

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
not() { ! "$@"; }

export HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1
g() { git -c safe.directory='*' "$@"; }

# A bare repository at $1 whose HEAD is a FIFO.
trap_repo() {
	g init --bare -q "$1" && rm "$1/HEAD" && mkfifo "$1/HEAD"
	fifos+=("$1/HEAD")
}
put() {
	mkdir -p "$(dirname "$work/$1")"
	printf '%s\n' "${2:-$1}" > "$work/$1"
}

volumes="$tmp/volumes"
vol="$volumes/student/tp"
work="$vol/work"
outside="$tmp/elsewhere.git"
fifos=()
weird=$'a/we ird*[x]#!\\\nname'

put .git/HEAD 'ref: refs/heads/main'
put main.c
put a/b/kept.c
put clone2/beside.c
put clone/inside.c
put a/b/gitfile/inside.c
put link/inside.c
put "$weird/inside.c"
put a/b/deeper/repo/inside.c
trap_repo "$outside"
trap_repo "$work/clone/.git"
trap_repo "$work/a/b/deeper/repo/.git"
put a/b/gitfile/.git "gitdir: $outside"
put "$weird/.git" "gitdir: $outside"
ln -s "$outside" "$work/link/.git"
# A real clone with a commit: what `add -A` would record as a gitlink.
put real/inside.c
g -C "$work/real" init -q
g -C "$work/real" -c user.name=s -c user.email=s@s commit -q --allow-empty -m one
if [ "$(id -u)" != 0 ]; then
	put secret.c
	chmod 000 "$work/secret.c"
fi
mkdir -p "$volumes/staff/review-tp/work"
printf 'x\n' > "$volumes/staff/review-tp/work/x.c"

# Runs the script once; prints its summary line, then `opened <n>`.
snap() {
	local opened=0 f
	CODESPACE_VOLUMES="$volumes" bash "$here/shadow-snapshot.sh" > "$tmp/out" 2>&1 &
	local pid=$!
	while kill -0 "$pid" 2>/dev/null; do
		for f in "${fifos[@]}"; do
			if timeout 0.2 sh -c ': > "$1"' sh "$f" 2>/dev/null; then
				opened=$((opened + 1))
			fi
		done
	done
	wait "$pid"
	cat "$tmp/out"
	printf 'opened %d\n' "$opened"
}

first="$(snap)"
shadow="$vol/shadow.git"
index="$(g --git-dir="$shadow" ls-files --stage)"
tree="$(g --git-dir="$shadow" ls-tree -r --name-only HEAD 2>/dev/null)"

expect "opens no nested .git" grep -qx 'opened 0' <<< "$first"
expect "takes one snapshot and fails none" grep -q ': 1 snapshots, 0 unchanged, 0 failed$' <<< "$first"
expect "records no gitlink" not grep -q '^160000 ' <<< "$index"
expect "captures the ordinary files, at the top and beside a nested repository" \
	diff <(printf '%s\n' a/b/kept.c clone2/beside.c main.c) <(printf '%s\n' "$tree")
expect "excludes every nested repository, the weird name included, and no more" \
	diff <(printf '%s\n' .git /a/b/deeper/repo/ /a/b/gitfile/ '/a/we\ ird\*\[x\]\#\!\\?name/' /clone/ /link/ /real/) \
	<(sort "$shadow/info/exclude")
expect "skips a review session" not test -e "$volumes/staff/review-tp/shadow.git"

second="$(snap)"
expect "opens nothing the second time either" grep -qx 'opened 0' <<< "$second"
expect "commits nothing when nothing changed" grep -q ': 0 snapshots, 1 unchanged, 0 failed$' <<< "$second"

rm "$work/link/.git"
third="$(snap)"
expect "captures a directory again once its .git is gone" \
	grep -qx link/inside.c <<< "$(g --git-dir="$shadow" ls-tree -r --name-only HEAD)"

# The control: without the exclusion, git does open the trap.
printf '.git\n' > "$shadow/info/exclude"
g --git-dir="$shadow" read-tree --empty
control="$(
	g --git-dir="$shadow" --work-tree="$work" add -A --ignore-errors >/dev/null 2>&1 &
	pid=$!
	n=0
	while kill -0 "$pid" 2>/dev/null; do
		for f in "${fifos[@]}"; do
			timeout 0.2 sh -c ': > "$1"' sh "$f" 2>/dev/null && n=$((n + 1))
		done
	done
	echo "$n"
)"
expect "the trap catches a plain git add -A (the control)" test "$control" -gt 0

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
