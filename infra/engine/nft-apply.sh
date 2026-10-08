#!/usr/bin/env bash
# Applies infra/engine/host.nft on the engine VM behind a dead man's switch
# (M6-05 part 3). As root, from the production checkout; the procedure is
# deployment.md §3, The host firewall. Never run by a deploy.
#
#   nft-apply.sh [apply]   check the file, arm a rollback in 180 s, load it
#   nft-apply.sh confirm   stop the rollback and make the table permanent
#
# The rollback reloads the table as it was before the apply (deletes it
# after a first apply). /etc changes at confirm only, so a reboot inside the
# window boots the last confirmed version.
set -euo pipefail

CANDIDATE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)/host.nft"
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
	cat <<-EOF
		nft-apply: table inet host loaded; rolled back in ${DELAY}s unless confirmed.
		Keep this session open; from other terminals run the three checks:
		  infra/engine/nft-check.sh outside | app | vm
		All green: $0 confirm. Otherwise do nothing.
	EOF
}

confirm() {
	pending || die "no rollback armed (already rolled back, or nothing applied): run '$0' first"
	systemctl stop "$UNIT.timer"
	install -d -m 0755 "$(dirname "$ACTIVE")"
	install -m 0644 "$RUN/pending.nft" "$ACTIVE"
	if ! grep -qF "$MARK" "$CONF" 2>/dev/null; then
		# The packaged file, kept without its `flush ruleset`, which would
		# wipe the codespace and netavark tables if restored as is.
		if [ -e "$CONF" ] && [ ! -e "$CONF.before-quiz" ]; then
			sed 's/^\([[:space:]]*flush ruleset\)/# \1 (disabled by quiz)/' "$CONF" >"$CONF.before-quiz"
		fi
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

[ "$(id -u)" -eq 0 ] || die "run as root"
case "${1:-apply}" in
	apply) apply ;;
	confirm) confirm ;;
	*) die "usage: $0 [apply | confirm]" ;;
esac
