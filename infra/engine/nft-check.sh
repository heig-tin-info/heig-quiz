#!/usr/bin/env bash
# Checks the engine VM's host input policy (infra/engine/host.nft) from where
# each flow comes from; deployment.md §3, The host firewall. Exits non-zero
# on any failure.
#
#   nft-check.sh outside   the workstation: SSH, :80, the staging portal's
#                          /healthz over IPv4 (443), :8443 and a closed port
#                          silently dropped
#   nft-check.sh app       the application VM: SSH, :8443 answers (401
#                          without RUNNER_TOKEN, 200 with it)
#   nft-check.sh vm        the engine VM, as root: the tables, the policy,
#                          the drop counter, then the codespace network
#                          assertions of both instances
set -uo pipefail

HOST=code.chevallier.io
HOST6=2a01:4f9:c015:4d4b::1
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
	if ! ip -6 route get "$HOST6" >/dev/null 2>&1; then
		skip "SSH over IPv6 (no IPv6 route here)"
	elif [ "$(ssh_banner "$HOST6")" = SSH- ]; then pass "SSH on [$HOST6]"
	else fail "SSH on [$HOST6]"; fi
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
		expect "HTTP :80 answers" '[1-5][0-9][0-9]' "http://$HOST/"
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
		for t in host codespace netavark; do
			if nft list table inet "$t" >/dev/null 2>&1; then pass "table inet $t loaded"; else fail "table inet $t missing"; fi
		done
		if nft list chain inet host input 2>/dev/null | grep -q 'policy drop;'; then pass "input policy drop"; else fail "input policy is not drop"; fi
		if systemctl is-active --quiet quiz-host-nft-rollback.timer; then
			echo "  ..    rollback armed: confirm once every check is green"
		fi
		nft list chain inet host input | grep -o 'counter packets [0-9]* bytes [0-9]*' | sed 's/^/  ..    dropped: /'
		for i in prod staging; do
			if CS_INSTANCE=$i /usr/local/lib/quiz-codespace/infra/net/test.sh >/dev/null 2>&1; then
				pass "codespace network assertions ($i)"
			else
				fail "codespace network assertions ($i): rerun CS_INSTANCE=$i /usr/local/lib/quiz-codespace/infra/net/test.sh"
			fi
		done
		;;
	*) echo "usage: $0 outside | app | vm" >&2; exit 2 ;;
esac
exit "$FAILED"
