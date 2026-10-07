#!/usr/bin/env bash
#
# Shadow repository snapshot of every volume of one portal instance, as the
# host's root (analyse.md § 3.3, docs/v1.md D-V1-1). Run by
# quiz-codespace-shadow@<instance>.timer every three minutes, with
# CODESPACE_VOLUMES=/srv/quiz-codespace/<instance>/volumes. Adapted from
# heig-classroom's deploy/shadow-snapshot.sh (M6-04).
#
# Why the host's root. The volume is mounted `:U`: Podman hands its ownership
# to the UID range `--userns=auto` drew for the container. The portal runs as
# root in its container but with EVERY capability dropped, so it reads the
# work tree only thanks to the container's umask 022: a `chmod 600` by the
# student leaves it a file it cannot read, and its snapshot is partial (the
# limit named in sessions/shadow.ts). This script has the capabilities, so the
# snapshot is complete.
#
# It does exactly what `snapshot()` in sessions/shadow.ts does:
#   git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A --ignore-errors
#   then commit if anything is staged,
# with the same two details: `info/exclude` holds `.git` (otherwise `add -A`
# records the student's repository as a submodule link and captures nothing),
# and the author is the portal, not the student. shadow.git stays root's, the
# owner the portal (root in its container) has too.
set -uo pipefail

VOLUMES="${CODESPACE_VOLUMES:?CODESPACE_VOLUMES is not set}"

export GIT_AUTHOR_NAME=codespace-portal
export GIT_AUTHOR_EMAIL=portal@codespace.local
export GIT_COMMITTER_NAME=codespace-portal
export GIT_COMMITTER_EMAIL=portal@codespace.local
# HOME neutralised as in git/gitRunner.ts: no personal configuration enters.
# safe.directory: the work tree belongs to the container's UID range.
export HOME=/nonexistent
GIT=(git -c 'safe.directory=*')

committed=0
skipped=0
failed=0

shopt -s nullglob
for work in "$VOLUMES"/*/*/work; do
	vol="$(dirname "$work")"
	gitdir="$vol/shadow.git"

	if [ ! -d "$gitdir" ]; then
		"${GIT[@]}" init --bare --quiet --initial-branch=main "$gitdir" || { failed=$((failed+1)); continue; }
	fi
	mkdir -p "$gitdir/info"
	printf '.git\n' > "$gitdir/info/exclude"

	# `--ignore-errors` stages what it can then exits non-zero; as root there is
	# normally nothing to ignore, and it stays as a safety net.
	"${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" add -A --ignore-errors >/dev/null 2>&1

	staged="$("${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" diff --cached --name-only 2>/dev/null | head -n 1)"
	if [ -z "$staged" ]; then
		skipped=$((skipped+1))
	elif "${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" \
		commit -q -m "snapshot $(date -Is)" >/dev/null 2>&1; then
		committed=$((committed+1))
	else
		failed=$((failed+1))
	fi
done

printf 'shadow repositories under %s: %d snapshots, %d unchanged, %d failed\n' \
	"$VOLUMES" "$committed" "$skipped" "$failed"
exit 0
