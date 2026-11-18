#!/usr/bin/env bash
# Tests of student-image.sh, the student image's rebuild by the production
# portal deploy: when it builds, that the image in service takes the new tag
# only after the acceptance test passed, and what a failure leaves. The
# script and the real images/build.sh run in a throwaway git repository,
# against a stub podman that logs its argv, a stub df and a stub test.sh.
# No root, no Podman. Run by the CI's `checks` job, or:
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

# The checkout: the scripts as they are, but the instance's env file and the
# build log under $work instead of /etc and /var/log.
repo="$work/repo"
for f in apps/codespace/deploy/lib.sh apps/codespace/deploy/student-image.sh \
	apps/codespace/images/build.sh apps/codespace/infra/net/common.sh infra/engine/lib.sh; do
	mkdir -p "$repo/$(dirname "$f")"
	cp "$root/$f" "$repo/$f"
done
sed -i "s|CS_ETC=\"/etc/quiz-codespace/\$1\"|CS_ETC=\"$work/etc/\$1\"|" "$repo/apps/codespace/deploy/lib.sh"
sed -i "s|^LOG=.*|LOG=$work/build.log|" "$repo/apps/codespace/deploy/student-image.sh"
expect "the test reaches the env file" grep -qF "$work/etc/" "$repo/apps/codespace/deploy/lib.sh"
expect "the test reaches the log" grep -qx "LOG=$work/build.log" "$repo/apps/codespace/deploy/student-image.sh"
mkdir -p "$repo/apps/codespace/infra/nft" "$work/etc/prod"
cdev="$repo/apps/codespace/images/c-dev"
mkdir -p "$cdev"
printf 'FROM scratch\nARG CS_VERSION=4.137.0\n' > "$cdev/Containerfile"
# The acceptance test's stub: logs the image and the AppArmor profile it was
# given, fails on demand.
cat > "$cdev/test.sh" <<EOF
#!$(command -v bash)
printf 'test.sh %s APPARMOR=%s\n' "\$*" "\${APPARMOR-unset}" >> "$work/log"
if [ -e "$work/state/test-fails" ]; then echo "FAIL: section 3 broke"; exit 1; fi
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
# The store: $state/label is the label of the image in service (no file, no
# image); the dangling list gains a leftover once a build ran.
cat > "$bin/podman" <<EOF
#!$(command -v bash)
printf 'podman %s\n' "\$*" >> "$work/log"
s="$work/state"
case " \$* " in
	*" image inspect "*) cat "\$s/label" 2>/dev/null ;;
	*" images --quiet --no-trunc --filter dangling=true "*)
		echo sha256:before
		[ ! -e "\$s/built" ] || echo sha256:leftover ;;
	*" build "*)
		touch "\$s/built"
		if [ -e "\$s/build-fails" ]; then echo "Error: building at STEP 1"; exit 1; fi ;;
esac
EOF
cat > "$bin/df" <<EOF
#!$(command -v bash)
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 40000000 30000000 \$(cat "$work/state/avail") 75% /"
EOF
chmod +x "$bin/podman" "$bin/df"

# run [label=<l>] [avail=<KiB>] [env=<line>] [<flag file>...] [-- <args>]:
# one run of the script on a fresh state.
run() {
	rm -rf "$work/state" "$work/log" "$work/etc/prod/env"
	mkdir -p "$work/state"
	echo 8000000 > "$work/state/avail"
	while [ $# -gt 0 ] && [ "$1" != -- ]; do
		case "$1" in
			label=*) echo "${1#label=}" > "$work/state/label" ;;
			avail=*) echo "${1#avail=}" > "$work/state/avail" ;;
			env=*) echo "${1#env=}" >> "$work/etc/prod/env" ;;
			*) touch "$work/state/$1" ;;
		esac
		shift
	done
	[ $# -eq 0 ] || shift
	touch "$work/log"
	PATH="$bin:$PATH" QUIZ_DEPLOY_LOCKED=1 \
		"$repo/apps/codespace/deploy/student-image.sh" "$@" > "$work/out" 2>&1
	rc=$?
}
logged() { grep -qF -- "$1" "$work/log"; }
said() { grep -qF -- "$1" "$work/out"; }

run "label=$tree"
expect "unchanged: exits 0" is "$rc" 0
expect "unchanged: builds nothing" not logged " build "
expect "unchanged: sweeps by the label only" logged " image prune -f --filter label=heig-codespace.source-tree"

run label=89abcdef
expect "changed: exits 0" is "$rc" 0
expect "changed: builds the candidate, labelled with the tree" \
	logged " build -t $candidate --layers=false --label heig-codespace.source-tree=$tree "
expect "changed: tests the candidate, then gives it the image's tag" \
	diff <(grep -E "^test.sh|podman .* tag " "$work/log") \
	<(printf '%s\n' "test.sh $candidate APPARMOR=unset" \
		"podman --remote --url unix:///run/podman/podman.sock tag $candidate $image")
expect "changed: drops the candidate's name" logged " rmi $candidate"
expect "changed: removes what the build left dangling" logged " rmi sha256:leftover"
expect "changed: never what was dangling before" not logged " rmi sha256:before"

run label=
expect "unlabelled (built by hand): rebuilds" logged " tag $candidate $image"

run
expect "no image: builds it" logged " tag $candidate $image"

run "label=$tree" -- --force
expect "forced: rebuilds on the same tree" logged " tag $candidate $image"

run label=89abcdef env=CODESPACE_APPARMOR_PROFILE=
expect "an empty AppArmor profile in the env file: tested without one" \
	grep -qx "test.sh $candidate APPARMOR=" "$work/log"
run label=89abcdef env=CODESPACE_APPARMOR_PROFILE=codespace
expect "the env file's AppArmor profile: tested with it" grep -qx "test.sh $candidate APPARMOR=codespace" "$work/log"

run label=89abcdef env=CODESPACE_IMAGE=codespace/c-dev:4.140.0
expect "a tag for another code-server: builds that tag" logged " tag codespace/c-dev:4.140.0-candidate codespace/c-dev:4.140.0"
expect "a tag for another code-server: warns" said "warning"
run "label=$tree"
expect "the Containerfile's version: no warning" not said "warning"

run label=89abcdef test-fails
expect "test fails: exits 1" is "$rc" 1
expect "test fails: the image in service keeps its tag" not logged " tag "
expect "test fails: the candidate is removed" logged " rmi $candidate"
expect "test fails: the build's leftovers are removed" logged " rmi sha256:leftover"
expect "test fails: prints the log's tail" said "  | FAIL: section 3 broke"

run label=89abcdef build-fails
expect "build fails: exits 1" is "$rc" 1
expect "build fails: no test, no tag" not grep -qE '^test.sh| tag ' "$work/log"
expect "build fails: prints the log's tail" said "  | Error: building at STEP 1"

run label=89abcdef avail=3145727
expect "a KiB under 3 GiB free: exits 1" is "$rc" 1
expect "a KiB under 3 GiB free: builds nothing" not logged " build "
run label=89abcdef avail=3145728
expect "3 GiB free: builds" logged " build "

run label=89abcdef -- --check
expect "--check: exits 0" is "$rc" 0
expect "--check: changes nothing" not grep -qE ' (build|tag|rmi|prune) ' "$work/log"

printf 'x\n' > "$cdev/stray.txt"
run label=89abcdef
expect "an untracked file in images/c-dev: exits 1" is "$rc" 1
expect "an untracked file in images/c-dev: builds nothing" not logged " build "
rm "$cdev/stray.txt"

run label=89abcdef
expect "never forces a removal" not grep -qE ' rmi .*(-f|--force)' "$work/log"
unscoped_prune() { grep -E ' prune' "$work/log" | grep -qv 'label=heig-codespace.source-tree'; }
expect "never prunes without the label" not unscoped_prune

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
