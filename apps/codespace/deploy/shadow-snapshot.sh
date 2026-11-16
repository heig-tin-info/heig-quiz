#!/usr/bin/env bash
#
# Shadow repository snapshot of every volume of one portal instance, as the
# host's root (analyse.md § 3.3, docs/history/v1.md D-V1-1). Run by
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
# with the same details: the author is the portal, not the student, and
# `info/exclude` is written afresh before each `add` — `.git`, then every
# directory under `work/` that holds a `.git` entry of any kind, at any depth
# (nested_excludes below). The host never reads nor runs git on a `.git` it did
# not create (apps/codespace/CLAUDE.md, invariant 13): without that exclusion
# `add -A` takes such a directory for an embedded repository, follows its
# `.git` (a directory, a gitfile `gitdir: <any path>`, a symbolic link) and
# reads the HEAD it points at, as root. Files under a nested repository are
# not captured (a gitlink captured none of them either). A `.git` created
# between the walk and the `add` is still probed once: shadow.ts's header
# says what the exclusion guarantees and what it does not. shadow.git stays
# root's, the owner the portal (root in its container) has too.
set -uo pipefail
# Bytes, not characters: names are matched as they are on disk.
export LC_ALL=C

VOLUMES="${CODESPACE_VOLUMES:?CODESPACE_VOLUMES is not set}"

# The exclusion lines of the directories under the work tree $1 that hold a
# `.git` entry: anchored, directory-only, the special characters escaped, a
# control character (a newline in a name: no line can hold it) as `?`, the
# same lines as excludeLine in src/sessions/shadow.ts. `find` never follows a
# link (-P, its default) and never descends into a `.git`; it only lists
# names. The first tr turns a name's newline into \001 and the -print0
# separator into the line end; the last turns every control character but
# the line end into `?`.
nested_excludes() {
	(cd "$1" && find . -path ./.git -prune -o -name .git -prune -print0 2>/dev/null) \
		| tr '\n\000' '\001\n' \
		| sed -e 's|^\./||' -e 's|/\.git$||' -e 's/[][\\*?!# ]/\\&/g' -e 's|.*|/&/|' \
		| tr '\001-\011\013-\037\177' '[?*]'
}

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
	# A staff member's review session keeps no history of what it opened
	# (ADR-129 §10): its directory goes when the session closes. `review-`
	# mirrors REVIEW_ASSIGNMENT_PREFIX (src/sessions/store.ts), a prefix the
	# platform's sync refuses for a project.
	case "$(basename "$vol")" in review-*) continue ;; esac
	gitdir="$vol/shadow.git"

	if [ ! -d "$gitdir" ]; then
		"${GIT[@]}" init --bare --quiet --initial-branch=main "$gitdir" || { failed=$((failed+1)); continue; }
	fi
	mkdir -p "$gitdir/info"
	{ printf '.git\n'; nested_excludes "$work"; } > "$gitdir/info/exclude"

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
