#!/usr/bin/env bash
#
# The online workspace's student image, rebuilt by the production portal
# deploy when its sources changed (ADR-016, amendment of 2026-11-18;
# RUNBOOK.md §7). The last step of `apps/codespace/deploy/install.sh prod`,
# once the portal of the same commit answers; by hand, as root, from
# production's checkout:
#   apps/codespace/deploy/student-image.sh            # rebuild if images/c-dev changed
#   apps/codespace/deploy/student-image.sh --force    # rebuild anyway
#   apps/codespace/deploy/student-image.sh --check    # say what it would do, change nothing
#
# Production only: the one image tag both instances run lives in the one
# rootful store, so it is built from approved commits only; the staging
# dispatcher runs nothing of a commit.
#
# The key: the git tree of images/c-dev at HEAD, which the image carries as
# a label (lib.sh, cs_student_image_plan). Same tree: nothing is built.
#
# Never breaks the image in service: the build goes to `<image>-candidate`,
# images/c-dev/test.sh runs against it, and only then does it take the
# image's tag. On a failure the image in service is untouched, the candidate
# and the build's leftovers are removed, the log's tail is printed and the
# exit code is 1, which fails the deploy job. Running sessions keep the
# container (and the image) they started with; new sessions take the new
# image.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh
cs_instance prod

force= check=
case "${1:-}" in
	"") ;;
	--force) force=1 ;;
	--check) check=1 ;;
	*)
		echo "usage: $0 [--force | --check]" >&2
		exit 2
		;;
esac

# One engine change at a time: a deploy already holds the VM's lock
# (infra/engine/deploy.sh), a run by hand takes it.
if [ -z "$check" ] && [ -z "${QUIZ_DEPLOY_LOCKED:-}" ]; then
	exec 9>/run/quiz-engine-deploy.lock
	if ! flock -w 60 9; then
		echo "student image: a deploy holds the engine VM's lock" >&2
		exit 4
	fi
	export QUIZ_DEPLOY_LOCKED=1
fi

# What the build would read must be the commit's: an edited, untracked or
# ignored file in the context would be built under the commit's label.
if [ -n "$(git status --porcelain --ignored --untracked-files=all -- "$CS_STUDENT_DIR")" ]; then
	echo "student image: $CS_STUDENT_DIR differs from the commit (git status): not built" >&2
	exit 1
fi
tree=$(git rev-parse "HEAD:$CS_STUDENT_DIR")
image=$(cs_student_image)
candidate="$image-candidate"

exists=no label=
if pd image exists "$image"; then
	exists=yes
	label=$(pd image inspect --format "{{index .Labels \"$CS_STUDENT_LABEL\"}}" "$image")
fi
plan=$(cs_student_image_plan "$exists" "$label" "$tree" "$force")

# An image a session used, replaced since and labelled: removed once no
# container uses it (never -f). Scoped by the label, never a global prune.
sweep() {
	pd image prune -f --filter "label=$CS_STUDENT_LABEL" >/dev/null 2>&1 || true
}

if [ "$plan" = keep ]; then
	echo "student image: $image is current (images/c-dev ${tree:0:12}), not rebuilt"
	[ -n "$check" ] || sweep
	exit 0
fi
echo "student image: $image to rebuild (${plan#build }; images/c-dev ${tree:0:12})"
[ -z "$check" ] || exit 0

avail=$(df -Pk /var/lib/containers 2>/dev/null | awk 'NR == 2 { print $4 }')
if ! cs_disk_room "$avail" "$CS_STUDENT_BUILD_KIB"; then
	echo "student image: ${avail:-unknown} KiB free under /var/lib/containers, $CS_STUDENT_BUILD_KIB needed: not rebuilt, $image unchanged (RUNBOOK.md, Disk)" >&2
	exit 1
fi

# The images no tag names, before the build: those after it that were not
# here are the build's leftovers, or the image the new one replaced.
dangling() { pd images --quiet --no-trunc --filter dangling=true | sort -u; }
before=$(dangling)
cleanup() {
	local id
	# The candidate's name; its image too, unless it now carries $image.
	pd rmi "$candidate" >/dev/null 2>&1 || true
	for id in $(comm -13 <(printf '%s\n' "$before") <(dangling)); do
		pd rmi "$id" >/dev/null 2>&1 || true
	done
	sweep
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log="${STUDENT_IMAGE_LOG:-/var/log/quiz-codespace-student-image.log}"
: > "$log"
fail() {
	{
		echo "student image: $1. $image is unchanged, new sessions keep starting on it. The end of $log:"
		tail -n 40 "$log" | sed 's/^/  | /'
	} >&2
	exit 1
}

# A leftover of an interrupted run would be tested in place of the build.
pd rmi "$candidate" >/dev/null 2>&1 || true
t0=$(date +%s)
# --layers=false: one commit at the end, no cached intermediate images.
apps/codespace/images/build.sh "$candidate" --layers=false \
	--label "$CS_STUDENT_LABEL=$tree" >> "$log" 2>&1 \
	|| fail "the build failed"
echo "student image: built in $(($(date +%s) - t0)) s; acceptance test (images/c-dev/test.sh)"
# The instance's AppArmor profile, as its sessions get it (empty: no flag).
if grep -q '^CODESPACE_APPARMOR_PROFILE=' "$CS_ETC/env" 2>/dev/null; then
	APPARMOR="$(cs_env CODESPACE_APPARMOR_PROFILE)"
	export APPARMOR
fi
apps/codespace/images/c-dev/test.sh "$candidate" >> "$log" 2>&1 \
	|| fail "the acceptance test failed"

pd tag "$candidate" "$image"
echo "student image: $image rebuilt from images/c-dev ${tree:0:12} in $(($(date +%s) - t0)) s." \
	"Running sessions keep their container until it restarts; new sessions start on the new image."
