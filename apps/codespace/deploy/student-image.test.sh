#!/usr/bin/env bash
# Tests of the student image's rebuild by the production deploy
# (student-image.sh, lib.sh's cs_student_image_plan and cs_disk_room): when
# it builds, that the image in service takes the new tag only after the
# acceptance test passed, and what a failure leaves. student-image.sh and the
# real images/build.sh run in a throwaway git repository, against a stub
# podman that logs its argv, a stub df and a stub test.sh. No root, no
# Podman. Run by the CI's `checks` job, or:
#   bash apps/codespace/deploy/student-image.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
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
not() { ! "$@"; }
is() { [ "$1" = "$2" ]; }

# --- The pure decision -------------------------------------------------------

# shellcheck source=lib.sh
. "$here/lib.sh"
t=0123456789abcdef0123456789abcdef01234567
expect "same tree: keep" is "$(cs_student_image_plan yes "$t" "$t")" keep
expect "another tree: build" is "$(cs_student_image_plan yes 89abcdef "$t")" "build changed"
expect "no label (built by hand): build" is "$(cs_student_image_plan yes "" "$t")" "build unlabelled"
expect "no image: build" is "$(cs_student_image_plan no "" "$t")" "build missing"
expect "forced: build, even on the same tree" is "$(cs_student_image_plan yes "$t" "$t" 1)" "build forced"
expect "3 GiB free: room" cs_disk_room 3145728 "$CS_STUDENT_BUILD_KIB"
expect "a KiB less: no room" not cs_disk_room 3145727 "$CS_STUDENT_BUILD_KIB"
expect "no df answer: no room" not cs_disk_room "" "$CS_STUDENT_BUILD_KIB"
expect "not a number: no room" not cs_disk_room "12G" "$CS_STUDENT_BUILD_KIB"

# --- The script, in a throwaway checkout -------------------------------------

repo="$work/repo"
for f in apps/codespace/deploy/lib.sh apps/codespace/deploy/student-image.sh \
	apps/codespace/images/build.sh apps/codespace/infra/net/common.sh infra/engine/lib.sh; do
	mkdir -p "$repo/$(dirname "$f")"
	cp "$root/$f" "$repo/$f"
done
# common.sh resolves the nftables directory beside it.
mkdir -p "$repo/apps/codespace/infra/nft"
cdev="$repo/apps/codespace/images/c-dev"
mkdir -p "$cdev"
printf 'FROM scratch\n' > "$cdev/Containerfile"
# The acceptance test's stub: logs the image it was given, fails on demand.
cat > "$cdev/test.sh" <<EOF
#!$(command -v bash)
printf 'test.sh %s APPARMOR=%s\n' "\$*" "\${APPARMOR-unset}" >> "$work/log"
echo "== 3. extensions"
if [ -e "$work/state/test-fails" ]; then echo "FAIL: section 3 broke"; exit 1; fi
echo "all passed"
EOF
chmod +x "$cdev/test.sh"
git -C "$repo" init -q
git -C "$repo" add apps infra
git -C "$repo" -c user.name=t -c user.email=t@t commit -qm init
tree=$(git -C "$repo" rev-parse HEAD:apps/codespace/images/c-dev)

image=codespace/c-dev:4.137.0
candidate=$image-candidate
bin="$work/bin"
mkdir -p "$bin"
# The store: $state/exists and $state/label describe the image in service;
# the dangling list gains a leftover once a build ran.
cat > "$bin/podman" <<EOF
#!$(command -v bash)
printf 'podman %s\n' "\$*" >> "$work/log"
s="$work/state"
case " \$* " in
	*" image exists "*) [ -e "\$s/exists" ] ;;
	*" image inspect "*) cat "\$s/label" 2>/dev/null; echo ;;
	*" images --quiet --no-trunc --filter dangling=true "*)
		echo sha256:before
		[ ! -e "\$s/built" ] || echo sha256:leftover ;;
	*" build "*)
		touch "\$s/built"
		echo "STEP 1/1: FROM scratch"
		if [ -e "\$s/build-fails" ]; then echo "Error: building at STEP 1"; exit 1; fi ;;
esac
EOF
cat > "$bin/df" <<EOF
#!$(command -v bash)
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 40000000 30000000 \$(cat "$work/state/avail") 75% /"
EOF
chmod +x "$bin/podman" "$bin/df"

# run <state setup...> -- [args]: one run of the script on a fresh state.
run() {
	rm -rf "$work/state" "$work/log"
	mkdir -p "$work/state"
	echo 8000000 > "$work/state/avail"
	while [ $# -gt 0 ] && [ "$1" != -- ]; do
		case "$1" in
			label=*) echo "${1#label=}" > "$work/state/label" ;;
			avail=*) echo "${1#avail=}" > "$work/state/avail" ;;
			*) touch "$work/state/$1" ;;
		esac
		shift
	done
	[ $# -eq 0 ] || shift
	touch "$work/log"
	PATH="$bin:$PATH" QUIZ_DEPLOY_LOCKED=1 STUDENT_IMAGE_LOG="$work/build.log" \
		"$repo/apps/codespace/deploy/student-image.sh" "$@" > "$work/out" 2>&1
	rc=$?
}
logged() { grep -qF -- "$1" "$work/log"; }
said() { grep -qF -- "$1" "$work/out"; }

run exists "label=$tree"
expect "unchanged: exits 0" is "$rc" 0
expect "unchanged: builds nothing" not logged " build "
expect "unchanged: says so" said "is current (images/c-dev ${tree:0:12}), not rebuilt"
expect "unchanged: sweeps the replaced images by label only" \
	logged "image prune -f --filter label=heig-codespace.source-tree"

run exists label=89abcdef
expect "changed: exits 0" is "$rc" 0
expect "changed: builds the candidate, labelled with the tree" \
	logged " build -t $candidate --layers=false --label heig-codespace.source-tree=$tree "
expect "changed: tests the candidate" logged "test.sh $candidate APPARMOR=unset"
expect "changed: the image takes the candidate's tag after the test" \
	diff <(grep -nE "test.sh|podman .* tag " "$work/log" | cut -d: -f2-) \
	<(printf '%s\n' "test.sh $candidate APPARMOR=unset" \
		"podman --remote --url unix:///run/podman/podman.sock tag $candidate $image")
expect "changed: drops the candidate's name" logged " rmi $candidate"
expect "changed: removes what the build left dangling" logged " rmi sha256:leftover"
expect "changed: never what was dangling before" not logged " rmi sha256:before"
expect "changed: says running sessions keep their container" said "Running sessions keep their container"

run label=
expect "missing image: builds it" logged " build -t $candidate "
expect "missing image: tags it" logged " tag $candidate $image"

run exists "label=$tree" -- --force
expect "forced: builds on the same tree" logged " build -t $candidate "

run exists label=89abcdef test-fails
expect "test fails: exits 1" is "$rc" 1
expect "test fails: the image in service keeps its tag" not logged " tag "
expect "test fails: the candidate is removed" logged " rmi $candidate"
expect "test fails: the build's leftovers are removed" logged " rmi sha256:leftover"
expect "test fails: prints the log's tail" said "  | FAIL: section 3 broke"
expect "test fails: says the image is unchanged" said "$image is unchanged"

run exists label=89abcdef build-fails
expect "build fails: exits 1" is "$rc" 1
expect "build fails: no test" not logged "test.sh"
expect "build fails: no tag" not logged " tag "
expect "build fails: prints the log's tail" said "  | Error: building at STEP 1"

run exists label=89abcdef avail=3145727
expect "under 3 GiB free: exits 1" is "$rc" 1
expect "under 3 GiB free: builds nothing" not logged " build "
expect "under 3 GiB free: says why" said "3145727 KiB free under /var/lib/containers"

run exists label=89abcdef -- --check
expect "--check: exits 0" is "$rc" 0
expect "--check: says what it would do" said "to rebuild (changed; images/c-dev ${tree:0:12})"
expect "--check: changes nothing" not grep -qE ' (build|tag|rmi|prune) ' "$work/log"

printf 'x\n' > "$cdev/stray.txt"
run exists label=89abcdef
expect "an untracked file in images/c-dev: exits 1" is "$rc" 1
expect "an untracked file in images/c-dev: builds nothing" not logged " build "
expect "an untracked file in images/c-dev: says why" said "differs from the commit"
rm "$cdev/stray.txt"

run exists label=89abcdef
expect "never forces a removal" not grep -qE ' rmi .*(-f|--force)' "$work/log"
unscoped_prune() { grep -E ' prune' "$work/log" | grep -qv 'label=heig-codespace.source-tree'; }
expect "never prunes without the label" not unscoped_prune

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
