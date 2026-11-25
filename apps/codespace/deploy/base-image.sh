#!/usr/bin/env bash
# Chooses the quiz-base release both portal instances run (ADR-146 §2–3,
# and its amendment of 2026-11-25): a step of `install.sh prod` before it
# restarts anything, or by hand as root from production's checkout (it
# takes the deploy lock):
#   apps/codespace/deploy/base-image.sh [--defer]
#
# Prints on standard output the image both quadlets name (their
# CODESPACE_DEFAULT_IMAGE and CODESPACE_IMAGE move together), and what it
# did on standard error:
#   - no release pinned (deploy/quiz-base.ref): the image the prod instance
#     runs (cs_base_current); exit 0;
#   - the pinned release is the one in service: it (pulled again if it
#     left the store); exit 0;
#   - a new candidate: proven public by an anonymous registry call, pulled
#     anonymously by digest, its io.quiz.base.version label the pin's tag,
#     and the image's three acceptance tests run against that digest from
#     this checkout; a pass prints it, exit 0. Anything else prints the
#     image in service, exit 1: the deploy keeps it and fails at the end.
#     With --defer (sessions run, a forced deploy) the image in service
#     stays, exit 0, the next deploy switches.
# RUNBOOK.md §7 says what a failure means.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh
cs_instance prod

DIR=apps/codespace/images/quiz-base
TESTS=(test.sh test-hardening.sh test-toolchain.sh)
# The release (~1.6 GB) beside the image in service, in KiB.
NEED_KIB=$((3 * 1024 * 1024))
LOG=/var/log/quiz-codespace-base-image.log

defer=''
case "${1:-}" in
	"") ;;
	--defer) defer=1 ;;
	*)
		echo "usage: $0 [--defer]" >&2
		exit 2
		;;
esac

if ! engine_lock 60; then
	echo "base image: a deploy holds the engine VM's lock" >&2
	exit 4
fi

say() { echo "base image: $*" >&2; }
installed=$(cs_base_installed)
# keep <status>: the image in service stays.
keep() {
	cs_base_current
	exit "$1"
}

if ! pin=$(cs_base_pin) || ! version=$(cs_base_pin --version); then
	say "the pin is unreadable (above): the image in service stays"
	keep 1
fi
if [ -z "$pin" ]; then
	say "no quiz-base release pinned yet (deploy/quiz-base.ref): the image in service stays"
	keep 0
fi

# Every pull below is anonymous: a credential would hide a package that is
# not public, which the portal's own pulls could not fetch.
anonymous() { pd logout ghcr.io >/dev/null 2>&1 || true; }

if [ "$pin" = "$installed" ]; then
	if pd image exists "$pin"; then
		say "$pin in service"
		keep 0
	fi
	say "$pin in service but gone from the store: pulling it again"
	anonymous
	pd pull -q "$pin" >&2 || { say "the pull failed: sessions cannot start until it is in the store"; keep 1; }
	keep 0
fi

if [ -n "$defer" ]; then
	say "$pin pinned, not switched to: sessions are running (a forced deploy); the next deploy switches"
	keep 0
fi
say "$pin pinned (quiz-base $version), ${installed:-a pre-ADR-146 image} in service: pulling and testing it"

# Public: an anonymous token, then the manifest by digest with it.
repo=${pin%@*}
path=${repo#ghcr.io/}
digest=${pin#*@}
token=$(curl -fsS -m 30 "https://ghcr.io/token?service=ghcr.io&scope=repository:$path:pull" \
	| sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || token=''
if [ -z "$token" ] || ! curl -fsS -m 30 -o /dev/null -I \
	-H "Authorization: Bearer $token" \
	-H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
	"https://ghcr.io/v2/$path/manifests/$digest"; then
	say "$pin is not readable anonymously: is the package public? (RUNBOOK.md §7)"
	keep 1
fi

avail=$(df -Pk /var/lib/containers 2>/dev/null | awk 'NR == 2 { print $4 }')
if ! [[ "$avail" =~ ^[0-9]+$ ]] || [ "$avail" -lt "$NEED_KIB" ]; then
	say "${avail:-unknown} KiB free under /var/lib/containers, $NEED_KIB needed: not pulled"
	keep 1
fi

: > "$LOG"
fail() {
	say "$1. The image in service stays, new sessions keep starting on it. The end of $LOG:"
	tail -n 40 "$LOG" | sed 's/^/  | /' >&2
	keep 1
}

t0=$(date +%s)
anonymous
pd pull -q "$pin" >> "$LOG" 2>&1 || fail "the pull failed"
# The release the pin names, not another one under its digest's tag.
label=$(pd image inspect --format '{{index .Labels "io.quiz.base.version"}}' "$pin" 2>>"$LOG" || true)
[ "$label" = "$version" ] || fail "$pin says io.quiz.base.version '${label}', the pin says $version"
# The sessions' AppArmor profile, when the env file sets one (empty: none).
if grep -q '^CODESPACE_APPARMOR_PROFILE=' "$CS_ETC/env" 2>/dev/null; then
	APPARMOR="$(cs_env CODESPACE_APPARMOR_PROFILE)"
	export APPARMOR
fi
# test.sh is strict about the image's revision: never its workstation opt-in.
unset QUIZ_BASE_ALLOW_UNKNOWN_REVISION
for t in "${TESTS[@]}"; do
	"$DIR/$t" "$pin" >> "$LOG" 2>&1 || fail "$t failed against $pin"
done
say "$pin pulled and tested in $(($(date +%s) - t0)) s: both instances switch to it; running sessions keep their container until it restarts"
echo "$pin"
