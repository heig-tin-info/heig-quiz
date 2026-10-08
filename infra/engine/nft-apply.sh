#!/usr/bin/env bash
# Applies infra/engine/host.nft on the engine VM behind a dead man's switch
# (M6-05 part 3; deployment.md §3, The host firewall). As root, from the
# production checkout (/opt/quiz-runner):
#
#   nft-apply.sh [apply]   check the file, arm a rollback in 180 s, load it,
#                          print the checks to run from outside
#   nft-apply.sh confirm   stop the rollback and make the table permanent:
#                          /etc/quiz-engine/host.nft, an /etc/nftables.conf
#                          that includes it (no `flush ruleset`), a drop-in
#                          so that stopping nftables.service removes this
#                          table only, the service enabled, the old empty
#                          `inet filter` table removed
#   nft-apply.sh deploy    what a production deploy runs (reload_host_nft):
#                          nothing until a first confirm, nothing while the
#                          checkout's file equals the confirmed copy;
#                          otherwise apply, check that the loaded chain still
#                          admits SSH, confirm (or leave the rollback armed
#                          and fail)
#
# The rollback reloads the table as it was before the apply (deletes it
# after a first apply), and the files under /etc change at confirm only: a
# reboot inside the window boots the last confirmed version.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CANDIDATE="$ENGINE_DIR/host.nft"
ACTIVE=/etc/quiz-engine/host.nft
RUN=/run/quiz-host-nft
UNIT=quiz-host-nft-rollback
DELAY=180
CONF=/etc/nftables.conf
DROPIN=/etc/systemd/system/nftables.service.d/quiz-host.conf
MARK='# quiz: infra/engine/nft-apply.sh'

die() { echo "nft-apply: $*" >&2; exit 1; }
pending() { systemctl is-active --quiet "$UNIT.timer"; }

apply() {
	nft -c -f "$CANDIDATE" || die "$CANDIDATE does not load (nft -c): nothing changed"
	pending && die "a rollback is already armed: run '$0 confirm', or wait for it"
	install -d -m 0700 "$RUN"
	{
		echo 'table inet host'
		echo 'delete table inet host'
		nft list table inet host 2>/dev/null || true
	} >"$RUN/rollback.nft"
	install -m 0644 "$CANDIDATE" "$RUN/pending.nft"
	systemctl reset-failed "$UNIT.timer" "$UNIT.service" >/dev/null 2>&1 || true
	systemd-run --quiet --unit="$UNIT" --on-active="$DELAY" \
		--timer-property=AccuracySec=1s /usr/sbin/nft -f "$RUN/rollback.nft"
	nft -f "$RUN/pending.nft"
	echo "nft-apply: table inet host loaded; rolled back in ${DELAY}s unless confirmed."
}

confirm() {
	pending || die "no rollback armed (already rolled back, or nothing applied): run '$0' first"
	systemctl stop "$UNIT.timer"
	install -d -m 0755 "$(dirname "$ACTIVE")"
	install -m 0644 "$RUN/pending.nft" "$ACTIVE"
	if ! grep -qF "$MARK" "$CONF" 2>/dev/null; then
		[ -e "$CONF" ] && cp -n "$CONF" "$CONF.before-quiz"
		cat >"$CONF" <<-EOF
			#!/usr/sbin/nft -f
			$MARK confirm.
			# Never \`flush ruleset\` here: the codespace and netavark tables are
			# loaded by their own units. The table: $ACTIVE.
			include "$ACTIVE"
		EOF
	fi
	install -d -m 0755 "$(dirname "$DROPIN")"
	cat >"$DROPIN" <<-EOF
		$MARK: stopping nftables removes the host table only,
		# never the codespace and netavark tables (the packaged ExecStop flushes
		# the whole ruleset).
		[Service]
		ExecStop=
		ExecStop=-/usr/sbin/nft delete table inet host
	EOF
	systemctl daemon-reload
	systemctl enable --quiet nftables.service
	if nft list table inet filter >/dev/null 2>&1; then
		nft delete table inet filter
	fi
	rm -rf "$RUN"
	echo "nft-apply: confirmed; $CONF includes $ACTIVE and nftables.service is enabled."
}

checks() {
	cat <<-EOF
		Within ${DELAY}s, from OTHER terminals (keep this session open):
		  workstation:     infra/engine/nft-check.sh outside
		  application VM:  infra/engine/nft-check.sh app
		  this VM:         infra/engine/nft-check.sh vm
		All green: $0 confirm. Otherwise do nothing: the table rolls back.
	EOF
}

[ "$(id -u)" -eq 0 ] || die "run as root"
case "${1:-apply}" in
	apply) apply && checks ;;
	confirm) confirm ;;
	deploy)
		if [ ! -f "$ACTIVE" ]; then
			echo "deploy: host nft not applied yet: run infra/engine/nft-apply.sh once (deployment.md §3)" >&2
		elif ! cmp -s "$CANDIDATE" "$ACTIVE"; then
			if pending; then
				echo "deploy: host nft changed, but a rollback is armed: not reloaded" >&2
			else
				apply
				# The one lockout a deploy could cause: SSH no longer admitted.
				if nft list chain inet host input | grep -qE '^[[:space:]]*tcp dport 22 accept'; then
					confirm
				else
					die "the new table does not admit tcp/22: it rolls back in ${DELAY}s"
				fi
			fi
		fi
		;;
	*) die "usage: $0 [apply | confirm | deploy]" ;;
esac
