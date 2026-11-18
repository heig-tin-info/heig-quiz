#!/usr/bin/env bash
# Rebuilds the student image when images/c-dev changed, tests it under a
# candidate tag, and only then gives it the image's tag: the last step of
# `install.sh prod`, or by hand as root from production's checkout.
#   apps/codespace/deploy/student-image.sh [--check | --force]
# RUNBOOK.md §7 says when and what a failure means; ADR-016 (2026-11-18) why.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh
cs_instance prod

# The build's whole context (images/build.sh): its git tree names what an
# image was built from, and the image carries it as this label.
LABEL=heig-codespace.source-tree
DIR=apps/codespace/images/c-dev
# The new image (~1.5 GB) beside the one in service, in KiB.
NEED_KIB=$((3 * 1024 * 1024))
LOG=/var/log/quiz-codespace-student-image.log

force= check=
case "${1:-}" in
	"") ;;
	--force) force=1 ;;
	--check) check=1 ;;
	*)
		echo "usage: $0 [--check | --force]" >&2
		exit 2
		;;
esac

if [ -z "$check" ] && ! engine_lock 60; then
	echo "student image: a deploy holds the engine VM's lock" >&2
	exit 4
fi

# The build reads the working tree, the label names the commit: they must
# agree. A `git status` that fails refuses too.
if ! dirty=$(git status --porcelain --ignored --untracked-files=all -- "$DIR") || [ -n "$dirty" ]; then
	echo "student image: $DIR differs from the commit (git status), not built" >&2
	exit 1
fi
tree=$(git rev-parse "HEAD:$DIR")
image=$(cs_student_image)
candidate="$image-candidate"

version=$(sed -n 's/^ARG CS_VERSION=//p' "$DIR/Containerfile")
if [ "${image##*:}" != "$version" ]; then
	echo "student image: warning: $image is tagged for another code-server than the Containerfile's $version: set CODESPACE_IMAGE (RUNBOOK.md §7, a code-server bump)" >&2
fi

label=$(pd image inspect --format "{{index .Labels \"$LABEL\"}}" "$image" 2>/dev/null || true)
sweep() { pd image prune -f --filter "label=$LABEL" >/dev/null 2>&1 || true; }
if [ -z "$force" ] && [ "$label" = "$tree" ]; then
	echo "student image: $image is current (tree ${tree:0:12}), not rebuilt"
	# A replaced image of ours that a session held, once it is free.
	[ -n "$check" ] || sweep
	exit 0
fi
echo "student image: $image to rebuild (label ${label:-none}, tree $tree)"
[ -z "$check" ] || exit 0

avail=$(df -Pk /var/lib/containers 2>/dev/null | awk 'NR == 2 { print $4 }')
if ! [[ "$avail" =~ ^[0-9]+$ ]] || [ "$avail" -lt "$NEED_KIB" ]; then
	echo "student image: ${avail:-unknown} KiB free under /var/lib/containers, $NEED_KIB needed: not rebuilt, $image unchanged" >&2
	exit 1
fi

# The images no tag names before the build; those that appear after it are
# its leftovers and the image it replaced (the first time, an unlabelled
# one the label sweep would never match). By ID, never -f: an image a
# container uses stays.
dangling() { pd images --quiet --no-trunc --filter dangling=true | sort -u; }
before=$(dangling)
cleanup() {
	local id
	# The candidate's name only, once its image also carries $image.
	pd rmi "$candidate" >/dev/null 2>&1 || true
	for id in $(comm -13 <(printf '%s\n' "$before") <(dangling)); do
		pd rmi "$id" >/dev/null 2>&1 || true
	done
	sweep
}
trap cleanup EXIT
# Without these, a SIGTERM runs EXIT while build.sh still runs, and the
# orphan re-creates the candidate after the cleanup.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

: > "$LOG"
fail() {
	{
		echo "student image: $1. $image is unchanged, new sessions keep starting on it. The end of $LOG:"
		tail -n 40 "$LOG" | sed 's/^/  | /'
	} >&2
	exit 1
}

# A leftover of an interrupted run would be tested in place of the build.
pd rmi "$candidate" >/dev/null 2>&1 || true
t0=$(date +%s)
apps/codespace/images/build.sh "$candidate" --layers=false --label "$LABEL=$tree" >> "$LOG" 2>&1 \
	|| fail "the build failed"
echo "student image: built in $(($(date +%s) - t0)) s, testing it (images/c-dev/test.sh)"
# The sessions' AppArmor profile, when the env file sets one (empty: none).
if grep -q '^CODESPACE_APPARMOR_PROFILE=' "$CS_ETC/env" 2>/dev/null; then
	APPARMOR="$(cs_env CODESPACE_APPARMOR_PROFILE)"
	export APPARMOR
fi
apps/codespace/images/c-dev/test.sh "$candidate" >> "$LOG" 2>&1 \
	|| fail "the acceptance test failed"

pd tag "$candidate" "$image"
echo "student image: $image rebuilt in $(($(date +%s) - t0)) s. Running sessions keep their container until it restarts; new ones start on the new image."
