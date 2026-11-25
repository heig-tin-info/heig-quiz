#!/usr/bin/env bash
# Tests of base-image.sh, the choice of the quiz-base release by the
# production portal deploy (ADR-146 §2–3, RUNBOOK.md §7): no pin keeps the
# image in service, a new pin is pulled anonymously and switched to only once
# its three acceptance tests passed, and what every failure leaves. Then
# lib.sh's pieces: the pin's parser and the quadlet's rendering. The scripts
# run in a throwaway copy of the checkout, against a stub podman that logs
# its argv, a stub curl, a stub df and stub acceptance tests.
# No root, no Podman, no network. Run by the CI's `checks` job, or:
#   bash apps/codespace/deploy/base-image.test.sh
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

# The checkout: the scripts as they are, but the env files, the quadlets
# and the log under $work instead of /etc and /var/log.
repo="$work/repo"
for f in apps/codespace/deploy/lib.sh apps/codespace/deploy/base-image.sh \
	apps/codespace/deploy/quiz-codespace.container apps/codespace/deploy/Caddyfile \
	apps/codespace/infra/net/common.sh infra/engine/lib.sh; do
	mkdir -p "$repo/$(dirname "$f")"
	cp "$root/$f" "$repo/$f"
done
lib="$repo/apps/codespace/deploy/lib.sh"
sed -i "s|CS_ETC=\"/etc/quiz-codespace/\$1\"|CS_ETC=\"$work/etc/\$1\"|" "$lib"
sed -i "s|^CS_QUADLET_DIR=.*|CS_QUADLET_DIR=$work/quadlets|" "$lib"
sed -i "s|^LOG=.*|LOG=$work/base.log|" "$repo/apps/codespace/deploy/base-image.sh"
expect "the test reaches the env file" grep -qF "$work/etc/" "$lib"
expect "the test reaches the quadlets" grep -qx "CS_QUADLET_DIR=$work/quadlets" "$lib"
expect "the test reaches the log" grep -qx "LOG=$work/base.log" "$repo/apps/codespace/deploy/base-image.sh"
mkdir -p "$work/etc/prod" "$work/quadlets" "$repo/apps/codespace/infra/nft"

# The acceptance tests' stubs: each logs its name, the image and the
# AppArmor profile it was given, and fails on demand.
tests="$repo/apps/codespace/images/quiz-base"
mkdir -p "$tests"
for t in test.sh test-hardening.sh test-toolchain.sh; do
	cat > "$tests/$t" <<EOF
#!$(command -v bash)
printf '%s %s APPARMOR=%s\n' "$t" "\$*" "\${APPARMOR-unset}" >> "$work/log"
if [ -e "$work/state/fail-$t" ]; then echo "FAIL: $t broke"; exit 1; fi
EOF
	chmod +x "$tests/$t"
done

DIGEST=sha256:$(printf 'a%.0s' $(seq 1 64))
OTHER=sha256:$(printf 'b%.0s' $(seq 1 64))
PIN="ghcr.io/heig-tin-info/quiz-base@$DIGEST"
bin="$work/bin"
mkdir -p "$bin"
# The store: $state/present lists the images it holds.
cat > "$bin/podman" <<EOF
#!$(command -v bash)
printf 'podman %s\n' "\$*" >> "$work/log"
s="$work/state"
case " \$* " in
	*" image exists "*) grep -qxF -- "\${@: -1}" "\$s/present" 2>/dev/null ;;
	*" image inspect "*) cat "\$s/label" ;;
	*" pull "*)
		if [ -e "\$s/pull-fails" ]; then echo "Error: pulling: unauthorized"; exit 125; fi
		echo "\${@: -1}" >> "\$s/present"
		echo sha256:pulledid ;;
esac
EOF
cat > "$bin/curl" <<EOF
#!$(command -v bash)
printf 'curl %s\n' "\$*" >> "$work/log"
case "\$*" in
	*/token\?*) echo '{"token":"anonymous"}' ;;
	*/manifests/*) [ ! -e "$work/state/private" ] || exit 22 ;;
esac
EOF
cat > "$bin/df" <<EOF
#!$(command -v bash)
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 40000000 30000000 \$(cat "$work/state/avail") 75% /"
EOF
chmod +x "$bin/podman" "$bin/curl" "$bin/df"

# run [pin=<line>] [installed=<image>] [env=<line>] [present=<image>]
#     [avail=<KiB>] [label=<version>] [<flag file>...] [-- <args>]: one run
# on a fresh state. The pulled image's io.quiz.base.version is the pin's
# unless label= says otherwise.
run() {
	rm -rf "$work/state" "$work/log" "$work/base.log" "$work/etc/prod/env" "$work/quadlets"/*
	mkdir -p "$work/state"
	echo 8000000 > "$work/state/avail"
	printf '# no release pinned\n' > "$repo/apps/codespace/deploy/quiz-base.ref"
	while [ $# -gt 0 ] && [ "$1" != -- ]; do
		case "$1" in
			pin=*)
				printf '# a comment\n\n%s\n' "${1#pin=}" > "$repo/apps/codespace/deploy/quiz-base.ref"
				v=${1#*quiz-base:}
				[ -e "$work/state/label" ] || echo "${v%%@*}" > "$work/state/label"
				;;
			label=*) echo "${1#label=}" > "$work/state/label" ;;
			installed=*) printf '[Container]\nEnvironment=CODESPACE_DEFAULT_IMAGE=%s\n' "${1#installed=}" > "$work/quadlets/quiz-codespace-prod.container" ;;
			env=*) echo "${1#env=}" >> "$work/etc/prod/env" ;;
			present=*) echo "${1#present=}" >> "$work/state/present" ;;
			avail=*) echo "${1#avail=}" > "$work/state/avail" ;;
			*) touch "$work/state/$1" ;;
		esac
		shift
	done
	[ $# -eq 0 ] || shift
	touch "$work/log"
	PATH="$bin:$PATH" QUIZ_DEPLOY_LOCKED=1 \
		"$repo/apps/codespace/deploy/base-image.sh" "$@" > "$work/out" 2> "$work/err"
	rc=$?
	out=$(cat "$work/out")
}
logged() { grep -qF -- "$1" "$work/log"; }
said() { grep -qF -- "$1" "$work/err"; }
pulled() { grep -qE '^podman .* pull ' "$work/log"; }
tested() { grep -qE '^test' "$work/log"; }

run
expect "no pin, no image anywhere: config.ts's default, exit 0" is "$rc:$out" "0:codespace/c-dev:4.137.0"

run env=CODESPACE_DEFAULT_IMAGE=codespace/c-dev:4.140.0 env=CODESPACE_IMAGE=codespace/c-dev:4.137.0
expect "no pin: exits 0" is "$rc" 0
expect "no pin: the env file's default image" is "$out" codespace/c-dev:4.140.0
expect "no pin: pulls and tests nothing" not grep -qE '^(podman|curl|test)' "$work/log"
expect "no pin: says so" said "no quiz-base release pinned yet"
run env=CODESPACE_IMAGE=codespace/c-dev:4.137.0
expect "no pin: else the env file's CODESPACE_IMAGE" is "$out" codespace/c-dev:4.137.0
run installed=codespace/c-dev:4.140.0 env=CODESPACE_DEFAULT_IMAGE=codespace/c-dev:4.137.0
expect "no pin: the installed quadlet's image first" is "$out" codespace/c-dev:4.140.0

run "pin=ghcr.io/heig-tin-info/quiz-base:1.0.0@$DIGEST" "installed=$PIN" "present=$PIN"
expect "the pin in service: exits 0" is "$rc" 0
expect "the pin in service: names it by digest" is "$out" "$PIN"
expect "the pin in service: pulls and tests nothing" not grep -qE '^(curl|test)|pull' "$work/log"

run "pin=ghcr.io/heig-tin-info/quiz-base:1.0.0@$DIGEST" "installed=$PIN"
expect "the pin in service, gone from the store: exits 0" is "$rc" 0
expect "the pin in service, gone from the store: pulled again, anonymously" \
	diff <(grep -E 'logout|pull' "$work/log") \
	<(printf '%s\n' "podman --remote --url unix:///run/podman/podman.sock logout ghcr.io" \
		"podman --remote --url unix:///run/podman/podman.sock pull -q $PIN")
expect "the pin in service, gone from the store: not tested again" not tested

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" installed=codespace/c-dev:4.137.0
expect "a new pin: exits 0" is "$rc" 0
expect "a new pin: names it by digest, the tag dropped" is "$out" "$PIN"
expect "a new pin: public first, then logged out, then pulled, then the three tests" \
	diff <(sed -E 's/^(curl) .*(token|manifests).*/\1 \2/; s/^(test[a-z.-]*) .*/\1/' "$work/log" | grep -vE '^podman .* image (exists|inspect) ') \
	<(printf '%s\n' "curl token" "curl manifests" \
		"podman --remote --url unix:///run/podman/podman.sock logout ghcr.io" \
		"podman --remote --url unix:///run/podman/podman.sock pull -q $PIN" \
		test.sh test-hardening.sh test-toolchain.sh)
expect "a new pin: each test against the digest" is "$(grep -c "^test[a-z.-]* $PIN APPARMOR=unset$" "$work/log")" 3
expect "a new pin: the public check asks the manifest by digest" logged "/v2/heig-tin-info/quiz-base/manifests/$DIGEST"
expect "a new pin: the public check asks an anonymous token" \
	grep -qE '^curl .*https://ghcr.io/token\?service=ghcr.io&scope=repository:heig-tin-info/quiz-base:pull$' "$work/log"

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" env=CODESPACE_APPARMOR_PROFILE=codespace
expect "the env file's AppArmor profile: tested with it" is "$(grep -c 'APPARMOR=codespace$' "$work/log")" 3
run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" env=CODESPACE_APPARMOR_PROFILE=
expect "an empty AppArmor profile: tested without one" is "$(grep -c 'APPARMOR=$' "$work/log")" 3

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" installed=codespace/c-dev:4.137.0 label=1.0.9
expect "another version's label: exits 1, the image in service stays" is "$rc:$out" "1:codespace/c-dev:4.137.0"
expect "another version's label: says so, tests nothing" said "says io.quiz.base.version '1.0.9', the pin says 1.1.0"
expect "another version's label: no test" not tested

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" installed=codespace/c-dev:4.137.0 fail-test-hardening.sh
expect "a test fails: exits 1" is "$rc" 1
expect "a test fails: the image in service stays" is "$out" codespace/c-dev:4.137.0
expect "a test fails: the next test does not run" not logged "test-toolchain.sh"
expect "a test fails: prints the log's tail" said "  | FAIL: test-hardening.sh broke"

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" "installed=ghcr.io/heig-tin-info/quiz-base@$OTHER" pull-fails
expect "the pull fails: exits 1, the release in service stays" is "$rc:$out" "1:ghcr.io/heig-tin-info/quiz-base@$OTHER"
expect "the pull fails: no test" not tested

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" installed=codespace/c-dev:4.137.0 private
expect "not public: exits 1, the image in service stays" is "$rc:$out" "1:codespace/c-dev:4.137.0"
expect "not public: pulls nothing" not pulled
expect "not public: says so" said "is the package public?"

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" avail=3145727
expect "a KiB under 3 GiB free: exits 1, pulls nothing" is "$rc:$(pulled && echo pulled)" "1:"
run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" avail=3145728
expect "3 GiB free: pulls" pulled

run "pin=ghcr.io/heig-tin-info/quiz-base:1.1.0@$DIGEST" installed=codespace/c-dev:4.137.0 -- --defer
expect "--defer (live sessions): exits 0, the image in service stays" is "$rc:$out" "0:codespace/c-dev:4.137.0"
expect "--defer: pulls and tests nothing" not grep -qE '^(curl|test)|pull' "$work/log"

for bad in "ghcr.io/heig-tin-info/quiz-base@$DIGEST" \
	"ghcr.io/heig-tin-info/quiz-base:latest@$DIGEST" \
	"docker.io/heig-tin-info/quiz-base:1.0.0@$DIGEST" \
	"ghcrXio/heig-tin-info/quiz-base:1.0.0@$DIGEST" \
	"ghcr.io/heig-tin-info/quiz-base:1.0.0@sha256:abc" \
	"ghcr.io/heig-tin-info/quiz-base:1.0.0@$DIGEST
ghcr.io/heig-tin-info/quiz-base:1.0.1@$OTHER"; do
	run "pin=$bad" installed=codespace/c-dev:4.137.0
	expect "a malformed pin ($(printf '%s' "$bad" | head -n 1 | cut -c1-48)…): exits 1, the image in service stays" \
		is "$rc:$out" "1:codespace/c-dev:4.137.0"
	expect "a malformed pin: pulls nothing" not pulled
done

run -- --now
expect "an unknown option: exits 2" is "$rc" 2

# lib.sh: the quadlet names the chosen image twice, and refuses to render
# without one.
render() {
	(
		# shellcheck source=lib.sh
		. "$lib"
		cs_instance prod
		CS_BASE_IMAGE="$1"
		cs_render "$repo/apps/codespace/deploy/quiz-codespace.container"
	)
}
quadlet=$(render "$PIN" 2>&1)
expect "the quadlet: the sessions' default image is the base image" \
	grep -qx "Environment=CODESPACE_DEFAULT_IMAGE=$PIN" <<<"$quadlet"
expect "the quadlet: the collection's reader runs it too" \
	grep -qx "Environment=CODESPACE_IMAGE=$PIN" <<<"$quadlet"
expect "the quadlet: no placeholder left" not grep -q '@[A-Z_]*@' <<<"$quadlet"
expect "the quadlet: no base image, no rendering" not render "" 2>/dev/null

# install.sh hands the live sessions over as --defer.
# shellcheck disable=SC2016  # the shell's text, not its value
expect "install.sh: live sessions defer the switch" \
	grep -qF 'base-image.sh ${live:+--defer}' "$root/apps/codespace/deploy/install.sh"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
