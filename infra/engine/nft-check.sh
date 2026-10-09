#!/usr/bin/env bash
# Checks the engine VM's host input policy (infra/engine/host.nft) from where
# each flow comes from; deployment.md §3, The host firewall. Exits non-zero
# on any failure.
#
#   nft-check.sh outside   the workstation: SSH, the staging portal's
#                          /healthz over IPv4 (443), :8443 and a closed port
#                          silently dropped
#   nft-check.sh app       the application VM: SSH, :8443 answers (401
#                          without RUNNER_TOKEN, 200 with it)
#   nft-check.sh vm        the engine VM, as root: the tables, the policy,
#                          the drop counter, then a probe container on each
#                          instance's codespace network
set -uo pipefail

HOST=code.chevallier.io
FAILED=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }
skip() { printf '  SKIP  %s\n' "$*"; }

# ssh_banner <address>: the server's banner, without authenticating.
ssh_banner() {
	# shellcheck disable=SC2016 # expanded by the inner bash
	timeout 8 bash -c 'exec 3<>"/dev/tcp/$1/22" && head -c 4 <&3' _ "$1" 2>/dev/null
}
check_ssh() {
	if [ "$(ssh_banner "$HOST")" = SSH- ]; then pass "SSH on $HOST (IPv4)"; else fail "SSH on $HOST (IPv4)"; fi
	# Over IPv6 only once the name has an AAAA (none today).
	local v6
	v6=$(getent ahostsv6 "$HOST" | awk '$1 !~ /^::ffff:/ {print $1; exit}')
	if [ -z "$v6" ]; then
		skip "SSH over IPv6 ($HOST has no AAAA)"
	elif ! ip -6 route get "$v6" >/dev/null 2>&1; then
		skip "SSH over IPv6 (no IPv6 route here)"
	elif [ "$(ssh_banner "$v6")" = SSH- ]; then pass "SSH on [$v6]"
	else fail "SSH on [$v6]"; fi
}
# http_code <curl args…>: the status code, or 000 with curl's exit code.
http_code() {
	local code rc
	code=$(curl -4 -s -o /dev/null -m 8 -w '%{http_code}' "$@"); rc=$?
	[ "$rc" -eq 0 ] && echo "$code" || echo "000/exit$rc"
}
expect() {   # expect <label> <wanted regex> <curl args…>
	local label=$1 want=$2 got
	shift 2
	got=$(http_code "$@")
	if [[ "$got" =~ ^($want)$ ]]; then pass "$label: $got"; else fail "$label: $got (wanted $want)"; fi
}

case "${1:-}" in
	outside)
		check_ssh
		expect "portal staging /healthz" 200 "https://code-dev.chevallier.io/healthz"
		# Dropped, not refused: curl times out (28) where Caddy would answer 403
		# and a closed port would reset (7).
		expect ":8443 from here dropped" '000/exit28' "https://$HOST:8443/health"
		expect "closed port 9418 dropped" '000/exit28' "http://$HOST:9418/"
		;;
	app)
		check_ssh
		if [ -n "${RUNNER_TOKEN:-}" ]; then
			expect ":8443 /health with the token" 200 -H "Authorization: Bearer $RUNNER_TOKEN" "https://$HOST:8443/health"
		else
			expect ":8443 /health without a token" 401 "https://$HOST:8443/health"
		fi
		;;
	vm)
		[ "$(id -u)" -eq 0 ] || { echo "nft-check: vm needs root" >&2; exit 2; }
		for t in "inet host" "inet codespace" "bridge codespace"; do
			# shellcheck disable=SC2086 # family and name, two words
			if nft list table $t >/dev/null 2>&1; then pass "table $t loaded"; else fail "table $t missing"; fi
		done
		# Podman's, and only while it uses nftables: informational.
		if nft list table inet netavark >/dev/null 2>&1; then
			echo "  ..    table inet netavark present"
		else
			echo "  ..    no table inet netavark (iptables backend, or no container yet)"
		fi
		# Captured, then matched: under pipefail, `nft … | grep -q` fails
		# whenever grep exits first and nft gets SIGPIPE.
		chain=$(nft list chain inet host input 2>/dev/null)
		if [[ "$chain" == *'policy drop;'* ]]; then pass "input policy drop"; else fail "input policy is not drop"; fi
		if systemctl is-active --quiet quiz-host-nft-rollback.timer; then
			echo "  ..    rollback armed: confirm once every check is green"
		fi
		grep -o 'counter packets [0-9]* bytes [0-9]*' <<<"$chain" | sed 's/^/  ..    dropped: /'
		# A throwaway container on each instance's closed network: its git
		# channel open, the other instance's closed (host.nft's cs0/cs1
		# accept relies on inet codespace for that), the host's SSH closed,
		# no egress. Not infra/net/test.sh: it listens on the gateway's 9418,
		# which a live portal holds, and its regression section reloads
		# inet codespace without isolation.
		# shellcheck source=SCRIPTDIR/../../apps/codespace/deploy/lib.sh
		. "$(dirname "${BASH_SOURCE[0]}")/../../apps/codespace/deploy/lib.sh"
		probe() { pd run --rm --network "$CS_NET" "$CS_ANCHOR_IMAGE" sh -c "$1" >/dev/null 2>&1; }
		declare -A gw
		for i in prod staging; do cs_instance "$i"; gw[$i]=$CS_GATEWAY; done
		for i in prod staging; do
			cs_instance "$i"
			other=$([ "$i" = prod ] && echo staging || echo prod)
			probe true || { fail "$i: cannot start a probe on $CS_NET"; continue; }
			if probe "nc -z -w 3 $CS_GATEWAY $CS_GIT_PORT"; then pass "$i: git channel $CS_GATEWAY:$CS_GIT_PORT open"
			else fail "$i: git channel $CS_GATEWAY:$CS_GIT_PORT closed (portal running?)"; fi
			if probe "! nc -z -w 3 ${gw[$other]} $CS_GIT_PORT"; then pass "$i: $other's git channel closed from $CS_NET"
			else fail "$i: $other's git channel ${gw[$other]}:$CS_GIT_PORT reachable from $CS_NET"; fi
			if probe "! nc -z -w 3 $CS_GATEWAY 22"; then pass "$i: host SSH closed from $CS_NET"
			else fail "$i: host SSH reachable from $CS_NET"; fi
			if probe "! nc -z -w 3 1.1.1.1 80"; then pass "$i: no egress from $CS_NET"
			else fail "$i: 1.1.1.1:80 reachable from $CS_NET"; fi
		done
		;;
	*) echo "usage: $0 outside | app | vm" >&2; exit 2 ;;
esac
exit "$FAILED"
