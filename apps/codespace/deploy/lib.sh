# Shared by install.sh (every deploy) and bootstrap.sh (once per instance):
# the closed table of the portal instances on the engine VM, and the two
# installation steps. Sourced, not executed; runs as root from a checkout
# (production's /opt/quiz-runner, or staging's /opt/quiz-engine-staging),
# at the commit being deployed. RUNBOOK.md says when.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the values are read by the scripts that source this file

CS_APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Host-level copies: what systemd runs at boot does not depend on where a
# later deploy left a checkout.
CS_LIB=/usr/local/lib/quiz-codespace
CS_IMAGE_REPO=ghcr.io/heig-tin-info/quiz-codespace

# pd(), pull_retag, drop_old_sha_tags
# shellcheck source=../../../infra/engine/lib.sh
. "$CS_APP/../../infra/engine/lib.sh"

# The instances. What differs between them is here, except the network
# values, which come from infra/net/common.sh (the file the network unit
# runs). Ports: 3100 was heig-classroom's portal; Quiz's take their own, so
# the two can run side by side during the switch.
cs_instance() {
	case "${1:-}" in
		prod)
			CS_HOST=code.chevallier.io
			CS_PORT=3110
			CS_PLATFORM=https://quiz.chevallier.io
			;;
		staging)
			CS_HOST=code-dev.chevallier.io
			CS_PORT=3120
			CS_PLATFORM=https://quiz.dev.chevallier.io
			;;
		*) return 1 ;;
	esac
	CS_INSTANCE="$1"
	CS_DATA="/srv/quiz-codespace/$1"
	CS_ETC="/etc/quiz-codespace/$1"
	CS_UNIT="quiz-codespace-$1"
	# CS_NET, CS_GATEWAY, CS_GIT_PORT, CS_IFACE, CS_ANCHOR, for CS_INSTANCE
	# (pd() stays infra/engine/lib.sh's, which common.sh sources too)
	# shellcheck source=../infra/net/common.sh
	. "$CS_APP/infra/net/common.sh"
}

# Host-level pieces, shared by both instances: the network scripts and the
# nftables table, the AppArmor profile, the shadow snapshot and backup export
# scripts, the systemd templates, the VM's two slices and its host input
# policy (shared with the runner's deploy). Written by bootstrap.sh and by a PRODUCTION deploy
# only, so that an ordinary staging deploy cannot change what production's
# containers run under by accident. Not a security boundary: the staging
# key is root on this VM (ADR-016, M6-04 amendment).
cs_install_host() {
	install -d -m 0755 "$CS_LIB/infra/net" "$CS_LIB/infra/nft"
	install -m 0755 "$CS_APP"/infra/net/{common,setup,teardown,test}.sh "$CS_LIB/infra/net/"
	install -m 0644 "$CS_APP"/infra/nft/*.nft "$CS_LIB/infra/nft/"
	install -m 0755 "$CS_APP/deploy/shadow-snapshot.sh" "$CS_APP/deploy/backup-export.sh" "$CS_LIB/"
	install -m 0644 "$CS_APP/deploy/quiz-codespace-net@.service" \
		"$CS_APP/deploy/quiz-codespace-shadow@.service" \
		"$CS_APP/deploy/quiz-codespace-shadow@.timer" /etc/systemd/system/
	install_slices
	reload_host_nft
	# The backup export's one dependency (deployment.md §3, Backup).
	command -v sqlite3 >/dev/null 2>&1 \
		|| echo "deploy: warning: no sqlite3 (apt install sqlite3): backup-export.sh cannot run" >&2
	# The table is the same for both bridges; `nft -f` replaces it atomically
	# (the file deletes and recreates it), so a rule change ships with the
	# deploy rather than at the next boot.
	nft -f "$CS_LIB/infra/nft/codespace.nft"
	# The student containers' profile (gdb under kernel 7, see the file).
	# `-r` replaces: a running container keeps the profile it started with.
	if command -v apparmor_parser >/dev/null 2>&1; then
		install -m 0644 "$CS_APP/infra/apparmor/codespace" /etc/apparmor.d/codespace
		apparmor_parser -r /etc/apparmor.d/codespace
	else
		echo "deploy: warning: no apparmor_parser, profile not loaded (CODESPACE_APPARMOR_PROFILE must be empty)" >&2
	fi
}

# One instance's pieces: its seccomp profile (a HOST path, opened by the
# Podman server), its quadlet and its Caddy site, generated from the
# templates with the values of cs_instance (never from a request).
cs_install_instance() {
	install -d -m 0700 "$CS_ETC"
	install -m 0644 "$CS_APP/infra/seccomp/codespace.json" "$CS_ETC/seccomp.json"
	local subst=(
		-e "s|@INSTANCE@|$CS_INSTANCE|g"
		-e "s|@HOST@|$CS_HOST|g"
		-e "s|@PORT@|$CS_PORT|g"
		-e "s|@NETWORK@|$CS_NET|g"
		-e "s|@GATEWAY@|$CS_GATEWAY|g"
		-e "s|@GIT_PORT@|$CS_GIT_PORT|g"
	)
	sed "${subst[@]}" "$CS_APP/deploy/quiz-codespace.container" \
		> "/etc/containers/systemd/$CS_UNIT.container"
	install -d -m 0755 /etc/caddy/conf.d
	sed "${subst[@]}" "$CS_APP/deploy/Caddyfile" > "/etc/caddy/conf.d/$CS_UNIT.caddy"
	chmod 0644 "/etc/containers/systemd/$CS_UNIT.container" "/etc/caddy/conf.d/$CS_UNIT.caddy"
	caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

# The student image the instance's env names (CODESPACE_IMAGE), or the
# default. Built on the VM by images/build.sh, never pulled.
cs_student_image() {
	local image
	image="$(sed -n 's/^CODESPACE_IMAGE=//p' "$CS_ETC/env" 2>/dev/null | tail -n 1)"
	echo "${image:-codespace/c-dev:4.137.0}"
}
