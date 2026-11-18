#!/usr/bin/env bash
# Tests of infra/engine/lib.sh's caddy_site and caddy_apply against stub
# curl, caddy and systemctl that log their argv: a fragment is installed
# only when it changed, Caddy is reloaded at most once and only when it does
# not run what the files give, and a reload that does not return is judged
# by what Caddy runs. No root, no Caddy; bash, coreutils' timeout and
# python3. Run by the CI's `checks` job, or:
#   bash infra/engine/caddy.test.sh
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

# The stubs read their behaviour from files in $work: the running config
# (curl's answer), the adapted files (caddy adapt's), how curl answers (ok,
# silent: the 28 of a timeout, down: refused) and how the reload behaves
# (ok, fail, slow-loaded: returns late, the new config running;
# slow-pending: returns late, the admin API silent; slow-not-loaded).
bash_path="$(command -v bash)"
bin="$work/bin"
mkdir -p "$bin"
cat > "$bin/curl" <<EOF
#!$bash_path
printf 'curl %s\n' "\$*" >> "$work/log"
case "\$(cat "$work/curl-mode")" in
	silent) exit 28 ;;
	down) exit 7 ;;
esac
cat "$work/running.json"
EOF
cat > "$bin/caddy" <<EOF
#!$bash_path
printf 'caddy %s\n' "\$*" >> "$work/log"
[ "\$1" != adapt ] || cat "$work/wanted.json"
EOF
cat > "$bin/systemctl" <<EOF
#!$bash_path
printf 'systemctl %s\n' "\$*" >> "$work/log"
case "\$(cat "$work/reload-mode")" in
	ok) cp "$work/wanted.json" "$work/running.json" ;;
	fail) exit 1 ;;
	slow-loaded) cp "$work/wanted.json" "$work/running.json"; exec sleep 5 ;;
	slow-pending) echo silent > "$work/curl-mode"; exec sleep 5 ;;
	slow-not-loaded) exec sleep 5 ;;
esac
EOF
chmod +x "$bin"/*
# The stubs come first for the whole test; it calls none of these itself.
PATH="$bin:$PATH"

before='{"apps":{"http":{"servers":{"srv0":{"listen":[":443"]}}}}}'
after='{"apps":{"http":{"servers":{"srv0":{"listen":[":443",":8443"]}}}}}'
# The same object as $after, its keys in another order: Caddy's /config/ is
# Go's map encoding (sorted keys), `caddy adapt` its struct order.
after_reordered='{"apps": {"http": {"servers": {"srv0": {"listen": [":443", ":8443"]}}}}}'

# setup <running> <wanted> <curl mode> <reload mode> <fragment change: yes|no>
setup() {
	printf '%s' "$1" > "$work/running.json"
	printf '%s' "$2" > "$work/wanted.json"
	echo "$3" > "$work/curl-mode"
	echo "$4" > "$work/reload-mode"
	: > "$work/log"
	echo 'site { respond 200 }' > "$work/installed.caddy"
	if [ "$5" = yes ]; then
		echo 'site { respond 204 }' > "$work/rendered.caddy"
	else
		cp "$work/installed.caddy" "$work/rendered.caddy"
	fi
}

# scenario <as setup>: caddy_site then caddy_apply in a subshell, the
# output in $work/out, the exit code in $rc.
rc=0
scenario() {
	setup "$@"
	(
		# shellcheck source=lib.sh
		. "$here/lib.sh"
		CADDY_RELOAD_TIMEOUT=1
		caddy_site "$work/rendered.caddy" "$work/installed.caddy" || exit 9
		caddy_apply
	) > "$work/out" 2>&1
	rc=$?
	cat "$work/log" >> "$work/all"
}
reloads() { grep -c '^systemctl reload caddy$' "$work/log"; }
installed() { cmp -s "$work/rendered.caddy" "$work/installed.caddy"; }

scenario "$before" "$before" ok ok no
expect "unchanged, running the files' config: exit 0, no reload" [ "$rc:$(reloads)" = 0:0 ]
expect "unchanged: the fragment is not rewritten" not grep -q 'installed.caddy changed' "$work/out"

scenario "$before" "$after" ok ok yes
expect "changed: the fragment is installed" installed
expect "changed: one reload, exit 0" [ "$rc:$(reloads)" = 0:1 ]

scenario "$after_reordered" "$after" ok ok yes
expect "a change Caddy already runs (compared as JSON): no reload" [ "$rc:$(reloads)" = 0:0 ]

scenario "$before" "$after" ok ok no
expect "unchanged but not running (an earlier reload did not take): reloaded" [ "$rc:$(reloads)" = 0:1 ]

scenario "$before" "$after" ok slow-loaded yes
expect "past the bound, the new config running: exit 0" [ "$rc:$(reloads)" = 0:1 ]

scenario "$before" "$after" ok slow-pending yes
expect "past the bound, the admin API silent: pending, exit 0" [ "$rc:$(reloads)" = 0:1 ]

scenario "$before" "$after" ok slow-not-loaded yes
expect "past the bound, the old config still running: exit 1" [ "$rc:$(reloads)" = 1:1 ]

scenario "$before" "$after" ok fail yes
expect "a failed reload, the old config running: exit 1" [ "$rc:$(reloads)" = 1:1 ]

scenario "$before" "$after" silent ok no
expect "an earlier reload pending, nothing changed: exit 0, no reload" [ "$rc:$(reloads)" = 0:0 ]

scenario "$before" "$after" silent ok yes
expect "an earlier reload pending, a site changed: exit 1, no reload queued" [ "$rc:$(reloads)" = 1:0 ]
expect "an earlier reload pending, a site changed: says so" grep -q 'still pending: this deploy.s site change is not live' "$work/out"

scenario "$before" "$after" down ok no
expect "admin API refused: reload as before" [ "$(reloads)" = 1 ]

# The portal's install.sh: cs_instance sources infra/engine/lib.sh again
# (through infra/net/common.sh) between the prod site and caddy_apply; the
# change must survive it.
setup "$before" "$after" silent ok yes
(
	# shellcheck source=../../apps/codespace/deploy/lib.sh
	. "$here/../../apps/codespace/deploy/lib.sh"
	CADDY_RELOAD_TIMEOUT=1
	cs_instance prod
	caddy_site "$work/rendered.caddy" "$work/installed.caddy" || exit 9
	cs_instance staging
	cs_instance prod
	caddy_apply
) > "$work/out" 2>&1
rc=$?
cat "$work/log" >> "$work/all"
expect "a change survives cs_instance re-sourcing lib.sh: pending + changed fails" [ "$rc:$(reloads)" = 1:0 ]

expect "never restarts nor stops Caddy" not grep -qE '^systemctl (restart|stop|kill)' "$work/all"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
