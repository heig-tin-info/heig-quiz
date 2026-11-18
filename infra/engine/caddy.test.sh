#!/usr/bin/env bash
# Tests of infra/engine/lib.sh's caddy_site and caddy_apply against stub
# curl, caddy, systemctl and ss, the first three logging their argv: a fragment
# is installed only when it changed, Caddy is reloaded at most once and only
# when it does not run what the files give, and a reload that does not
# return is judged by what Caddy runs. No root, no Caddy; bash, coreutils'
# timeout and python3. Run by the CI's `checks` job, or:
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
# hang: the 28 of a timeout, down: refused), how the reload behaves (ok,
# fail, hang-loaded, hang-silent, hang-not-loaded) and whether validate
# passes.
bash_path="$(command -v bash)"
bin="$work/bin"
mkdir -p "$bin"
cat > "$bin/curl" <<EOF
#!$bash_path
printf 'curl %s\n' "\$*" >> "$work/log"
case "\$(cat "$work/curl-mode")" in
	hang) exit 28 ;;
	down) exit 7 ;;
esac
cat "$work/running.json"
EOF
cat > "$bin/caddy" <<EOF
#!$bash_path
printf 'caddy %s\n' "\$*" >> "$work/log"
case "\$1" in
	adapt) cat "$work/wanted.json" ;;
	validate) [ "\$(cat "$work/validate-mode")" = ok ] ;;
esac
EOF
cat > "$bin/systemctl" <<EOF
#!$bash_path
printf 'systemctl %s\n' "\$*" >> "$work/log"
case "\$(cat "$work/reload-mode")" in
	ok) cp "$work/wanted.json" "$work/running.json" ;;
	fail) exit 1 ;;
	hang-loaded) cp "$work/wanted.json" "$work/running.json"; exec sleep 5 ;;
	hang-silent) echo hang > "$work/curl-mode"; exec sleep 5 ;;
	hang-not-loaded) exec sleep 5 ;;
esac
EOF
# `ss -Htn state established …`: Recv-Q, Send-Q, local, peer. The second
# has unsent data.
cat > "$bin/ss" <<EOF
#!$bash_path
printf '%s\n' '0 0 10.0.0.1:443 192.0.2.10:50001' '0 166400 10.0.0.1:443 192.0.2.11:50002'
EOF
chmod +x "$bin"/*

before='{"apps":{"http":{"servers":{"srv0":{"listen":[":443"]}}}}}'
after='{"apps":{"http":{"servers":{"srv0":{"listen":[":443",":8443"]}}}}}'
# The same object as $after, its keys in another order: Caddy's /config/ is
# Go's map encoding (sorted keys), `caddy adapt` its struct order.
after_reordered='{"apps": {"http": {"servers": {"srv0": {"listen": [":443", ":8443"]}}}}}'

# scenario <running> <wanted> <curl mode> <reload mode> <validate mode>
# <fragment change: yes|no>: runs caddy_site then caddy_apply in a
# subshell, the output in $work/out, the exit code in $rc.
rc=0
scenario() {
	printf '%s' "$1" > "$work/running.json"
	printf '%s' "$2" > "$work/wanted.json"
	echo "$3" > "$work/curl-mode"
	echo "$4" > "$work/reload-mode"
	echo "$5" > "$work/validate-mode"
	: > "$work/log"
	echo 'site { respond 200 }' > "$work/installed.caddy"
	if [ "$6" = yes ]; then
		echo 'site { respond 204 }' > "$work/rendered.caddy"
	else
		cp "$work/installed.caddy" "$work/rendered.caddy"
	fi
	(
		# shellcheck source=lib.sh
		. "$here/lib.sh"
		PATH="$bin:$PATH"
		CADDY_RELOAD_TIMEOUT=1
		caddy_site "$work/rendered.caddy" "$work/installed.caddy" || exit 9
		caddy_apply
	) > "$work/out" 2>&1
	rc=$?
	cat "$work/log" >> "$work/all"
}
reloads() { grep -c '^systemctl reload caddy$' "$work/log"; }
said() { grep -qF "$1" "$work/out"; }

scenario "$before" "$before" ok ok ok no
expect "unchanged, running the files' config: exit 0" [ "$rc" = 0 ]
expect "unchanged: no reload, no validate" [ "$(reloads)" = 0 ]
expect "unchanged: not even validated" not grep -q '^caddy validate' "$work/log"
expect "unchanged: says so" said "caddy: unchanged, no reload"
expect "unchanged: the fragment is not rewritten" not said "installed.caddy changed"

scenario "$before" "$after" ok ok ok yes
expect "changed: exit 0" [ "$rc" = 0 ]
expect "changed: the fragment is installed" cmp -s "$work/rendered.caddy" "$work/installed.caddy"
expect "changed: says which file" said "caddy: $work/installed.caddy changed"
expect "changed: validated, then reloaded once" \
	diff <(grep -E '^(caddy validate|systemctl)' "$work/log") \
	<(printf '%s\n' "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" "systemctl reload caddy")
expect "changed: says it reloaded" said "deploy: caddy reloaded"

scenario "$after_reordered" "$after" ok ok ok yes
expect "a change Caddy already runs (a comment): compared as JSON, no reload" [ "$rc:$(reloads)" = 0:0 ]
expect "a change Caddy already runs: says so" said "already runs this config, no reload"

scenario "$before" "$after" ok ok ok no
expect "unchanged but not running (an earlier reload did not take): reloaded" [ "$rc:$(reloads)" = 0:1 ]

scenario "$before" "$after" ok ok fail yes
expect "a config that does not validate: exit 1, no reload" [ "$rc:$(reloads)" = 1:0 ]

scenario "$before" "$after" ok hang-loaded ok yes
expect "a reload past the bound, the new config running: exit 0" [ "$rc" = 0 ]
expect "past the bound, running: one reload" [ "$(reloads)" = 1 ]
expect "past the bound, running: warns that the reload has not finished" said "the reload has not finished, harmless"

scenario "$before" "$after" ok hang-silent ok yes
expect "a reload past the bound, the admin API silent: exit 1" [ "$rc" = 1 ]
expect "silent: says the reload is blocked and why" said "Caddy reload blocked"
expect "silent: names the likely cause and what to do" said "long-lived connection keeps it from completing; re-run the deploy later"
expect "silent: counts the connections on :443, and the one with unsent data" \
	said "2 connection(s) established on :443, 1 with unsent data (Send-Q > 0)"
expect "silent: never prints a peer's address (the CI's log is public)" not said "192.0.2."

scenario "$before" "$after" ok hang-not-loaded ok yes
expect "a reload past the bound, the old config still running: exit 1" [ "$rc" = 1 ]
expect "not loaded: says Caddy does not run the new config" said "Caddy does not run the new config"

scenario "$before" "$after" ok fail ok yes
expect "a failed reload, the old config running: exit 1" [ "$rc" = 1 ]

scenario "$before" "$after" hang ok ok no
expect "admin API silent before, nothing changed: exit 0, no reload" [ "$rc:$(reloads)" = 0:0 ]
expect "silent before, nothing changed: warns" said "does not answer"

scenario "$before" "$after" hang ok ok yes
expect "admin API silent before, a change: exit 1, no reload queued behind it" [ "$rc:$(reloads)" = 1:0 ]
expect "silent before, a change: says the reload is blocked" said "Caddy reload blocked"

scenario "$before" "$after" down ok ok no
expect "admin API refused (not answering at all): reload as before" [ "$(reloads)" = 1 ]

expect "never restarts nor stops Caddy" not grep -qE '^systemctl (restart|stop|kill)' "$work/all"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
