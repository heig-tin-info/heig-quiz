#!/usr/bin/env bash
#
# Shadow repository snapshot of every volume of one portal instance, as the
# host's root (analyse.md § 3.3, docs/history/v1.md D-V1-1). Run by
# quiz-codespace-shadow@<instance>.timer every three minutes, with
# CODESPACE_VOLUMES=/srv/quiz-codespace/<instance>/volumes. Adapted from
# heig-classroom's deploy/shadow-snapshot.sh (M6-04).
#
# The only writer of shadow.git, for open and closed sessions alike: the
# portal takes no snapshot of its own. Why the host's root: the volume is
# mounted `:U`, so its files belong to the UID range `--userns=auto` drew for
# the container, and only a reader with the file-mode capabilities sees a
# file the student made `chmod 600`.
#
#   git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A --ignore-errors
#   then commit if anything is staged,
# `info/exclude` holding `.git` (otherwise `add -A` records the student's
# repository as a submodule link and captures nothing), the author the
# portal, never the student.
#
# A host-side read of work/, so shadow.git is never published and its content
# is untrusted (apps/codespace/CLAUDE.md, invariant 15); its reach is bounded
# by the unit's sandbox (quiz-codespace-shadow@.service).
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
