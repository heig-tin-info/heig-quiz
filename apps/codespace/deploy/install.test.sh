#!/usr/bin/env bash
# Tests of install.sh's order around the quiz-base choice (RUNBOOK.md §7):
# the live-session guard again after base-image.sh, the portal's :prod tag
# given back on any failure between the retag and the restart, the
# `quiz-base-in-service:` line. install.sh runs as it is, in a throwaway
# copy of the checkout whose lib.sh and base-image.sh are stubs logging
# what they are asked, with a stub git, systemctl, curl, journalctl and
# sleep. No root, no Podman. Run by the CI's `checks` job, or:
#   bash apps/codespace/deploy/install.test.sh
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
not() { ! "$@"; }
is() { [ "$1" = "$2" ]; }

deploy="$work/repo/apps/codespace/deploy"
mkdir -p "$deploy" "$work/bin"
cp "$here/install.sh" "$deploy/install.sh"
S="$work/state"

# The stub lib.sh: the functions install.sh calls, logging into $S/log.
# `pd ps` answers a session on its n-th call when $S/live-<n> exists.
cat > "$deploy/lib.sh" <<EOF
# shellcheck shell=bash
CS_IMAGE_REPO=ghcr.io/heig-tin-info/quiz-codespace
S="$S"
log() { printf '%s\n' "\$*" >> "\$S/log"; }
cs_instance() {
	[ "\$1" = prod ] || return 1
	CS_INSTANCE=prod CS_ETC="\$S/etc" CS_UNIT=quiz-codespace-prod CS_PORT=3110
}
pd() {
	log "pd \$*"
	case "\$1" in
		ps)
			n=\$((\$(cat "\$S/ps-calls" 2>/dev/null || echo 0) + 1))
			echo "\$n" > "\$S/ps-calls"
			[ ! -e "\$S/live-\$n" ] || echo cs-prod-session ;;
		image) echo sha256:previous ;;
	esac
}
pull_retag() { log "pull_retag \$*"; }
cs_base_installed() { cat "\$S/installed"; }
cs_base_current() { echo old-image; }
cs_install_host() { log cs_install_host; [ ! -e "\$S/host-fails" ]; }
cs_install_instance() { log "cs_install_instance \$CS_BASE_IMAGE"; echo "\$CS_BASE_IMAGE" > "\$S/installed"; }
caddy_apply() { log caddy_apply; }
drop_old_sha_tags() { log drop_old_sha_tags; }
EOF
cat > "$deploy/base-image.sh" <<EOF
#!$(command -v bash)
printf 'base-image.sh %s\n' "\$*" >> "$S/log"
cat "$S/base-out"
exit "\$(cat "$S/base-rc")"
EOF
cat > "$work/bin/git" <<EOF
#!$(command -v bash)
echo 0123456789abcdef0123456789abcdef01234567
EOF
cat > "$work/bin/systemctl" <<EOF
#!$(command -v bash)
printf 'systemctl %s\n' "\$*" >> "$S/log"
EOF
cat > "$work/bin/curl" <<EOF
#!$(command -v bash)
[ ! -e "$S/unhealthy" ]
EOF
printf '#!%s\n' "$(command -v bash)" > "$work/bin/journalctl"
printf '#!%s\n' "$(command -v bash)" > "$work/bin/sleep"
chmod +x "$deploy/install.sh" "$deploy/base-image.sh" "$work/bin"/*

# run [base=<image>] [base-rc=<n>] [force] [<flag file>...]: one deploy on a
# fresh state; the installed quadlet names old-image.
run() {
	rm -rf "$S"
	mkdir -p "$S/etc"
	touch "$S/etc/env" "$S/log"
	echo old-image > "$S/installed"
	echo new-pin > "$S/base-out"
	echo 0 > "$S/base-rc"
	local force=''
	for a in "$@"; do
		case "$a" in
			base=*) echo "${a#base=}" > "$S/base-out" ;;
			base-rc=*) echo "${a#base-rc=}" > "$S/base-rc" ;;
			force) force=1 ;;
			*) touch "$S/$a" ;;
		esac
	done
	PATH="$work/bin:$PATH" QUIZ_DEPLOY_FORCE="$force" "$deploy/install.sh" prod > "$work/out" 2> "$work/err"
	rc=$?
}
logged() { grep -qxF -- "$1" "$S/log"; }
restored() { logged "pd tag sha256:previous ghcr.io/heig-tin-info/quiz-codespace:prod"; }
installed() { cat "$S/installed"; }

run
expect "a new release: exits 0" is "$rc" 0
expect "a new release: both quadlets name it" is "$(installed)" new-pin
expect "a new release: the in-service line names it" grep -qx 'quiz-base-in-service: new-pin' "$work/out"
expect "a new release: the portal's tag is not given back" not restored
expect "the guard runs twice, around base-image.sh" is "$(grep -c '^pd ps ' "$S/log")" 2

run live-1
expect "a session at the start: exits 3" is "$rc" 3
expect "a session at the start: nothing pulled" not grep -q '^pull_retag' "$S/log"

run live-2
expect "a session during the tests: exits 3" is "$rc" 3
expect "a session during the tests: the portal's tag is given back" restored
expect "a session during the tests: nothing installed" not grep -q '^cs_install' "$S/log"

run live-2 force
expect "forced, a session during the tests: exits 0" is "$rc" 0
expect "forced, a session during the tests: the image in service stays" is "$(installed)" old-image
expect "forced, a session during the tests: says so" grep -qF 'a session started during the base image' "$work/err"
expect "forced, a session during the tests: the in-service line names it" grep -qx 'quiz-base-in-service: old-image' "$work/out"

run base= base-rc=1
expect "base-image.sh names nothing: exits 1" is "$rc" 1
expect "base-image.sh names nothing: the portal's tag is given back" restored
expect "base-image.sh names nothing: nothing installed" not grep -q '^cs_install' "$S/log"

run host-fails
expect "a failure after the retag, before the restart: exits non-zero" not is "$rc" 0
expect "a failure after the retag, before the restart: the portal's tag is given back" restored

run base=old-image base-rc=1
expect "a release that failed its tests: exits 1 at the end" is "$rc" 1
expect "a release that failed its tests: the portal deployed" logged "systemctl restart quiz-codespace-prod.service"
expect "a release that failed its tests: the portal's tag is kept" not restored
expect "a release that failed its tests: the in-service line names the image kept" grep -qx 'quiz-base-in-service: old-image' "$work/out"

run unhealthy
expect "unhealthy after the restart: exits 1" is "$rc" 1
expect "unhealthy after the restart: the tag is kept (the new pair is in service)" not restored

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
