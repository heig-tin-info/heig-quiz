# Shared by install.sh (every prod deploy), base-image.sh and bootstrap.sh
# (once per instance): the closed table of the portal instances on the
# engine VM, the quiz-base release they run, and the two installation
# steps. Sourced, not executed; runs as root from production's checkout,
# /opt/quiz-runner, at an approved commit. RUNBOOK.md says when.
# infra/engine/staging-dispatch.sh holds a frozen copy of the staging row
# (its test checks they agree).
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the values are read by the scripts that source this file

CS_APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Host-level copies: what systemd runs at boot does not depend on where a
# later deploy left a checkout.
CS_LIB=/usr/local/lib/quiz-codespace
CS_IMAGE_REPO=ghcr.io/heig-tin-info/quiz-codespace
CS_QUADLET_DIR=/etc/containers/systemd
# The quiz-base release both instances run (ADR-146 §3, RUNBOOK.md §7): the
# pin, and the repository it must name.
CS_BASE_REPO=ghcr.io/heig-tin-info/quiz-base
CS_BASE_PIN="$CS_APP/deploy/quiz-base.ref"

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
# scripts, the systemd templates, the VM's two slices (shared with the
# runner's deploy, as is the drift warning of the manual pieces) and the
# inotify limits (deploy/sysctl.conf). Written by
# bootstrap.sh and by a prod deploy only, both from production's approved
# checkout.
cs_install_host() {
	install -d -m 0755 "$CS_LIB/infra/net" "$CS_LIB/infra/nft"
	install -m 0755 "$CS_APP"/infra/net/{common,setup,teardown,test}.sh "$CS_LIB/infra/net/"
	install -m 0644 "$CS_APP"/infra/nft/*.nft "$CS_LIB/infra/nft/"
	install -m 0755 "$CS_APP/deploy/shadow-snapshot.sh" "$CS_APP/deploy/backup-export.sh" "$CS_LIB/"
	install -m 0644 "$CS_APP/deploy/quiz-codespace-net@.service" \
		"$CS_APP/deploy/quiz-codespace-shadow@.service" \
		"$CS_APP/deploy/quiz-codespace-shadow@.timer" /etc/systemd/system/
	install_slices
	# The inotify budget every session container shares (the file says why).
	install -m 0644 "$CS_APP/deploy/sysctl.conf" /etc/sysctl.d/60-quiz-codespace.conf
	sysctl -q -p /etc/sysctl.d/60-quiz-codespace.conf
	warn_manual_drift
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

# cs_render <template>: the template with the values of cs_instance (never
# from a request) and the base image the caller chose, CS_BASE_IMAGE, on
# standard output. Fails when CS_BASE_IMAGE is empty or when a placeholder
# is left: a template naming a value this table lacks would ship it.
cs_render() {
	if [ -z "${CS_BASE_IMAGE:-}" ]; then
		echo "deploy: no CS_BASE_IMAGE to render $1 with (base-image.sh, RUNBOOK.md §7)" >&2
		return 1
	fi
	local out
	out=$(sed -e "s|@INSTANCE@|$CS_INSTANCE|g" \
		-e "s|@HOST@|$CS_HOST|g" \
		-e "s|@PLATFORM_URL@|$CS_PLATFORM|g" \
		-e "s|@PORT@|$CS_PORT|g" \
		-e "s|@NETWORK@|$CS_NET|g" \
		-e "s|@GATEWAY@|$CS_GATEWAY|g" \
		-e "s|@GIT_PORT@|$CS_GIT_PORT|g" \
		-e "s|@BASE_IMAGE@|$CS_BASE_IMAGE|g" \
		"$1") || return 1
	if grep -q '@[A-Z_][A-Z_]*@' <<<"$out"; then
		echo "deploy: $1 (for $CS_UNIT) still holds a @PLACEHOLDER@" >&2
		return 1
	fi
	printf '%s\n' "$out"
}

# One instance's pieces: its seccomp profile (a HOST path, opened by the
# Podman server), its quadlet and its Caddy site, rendered by cs_render. It
# validates Caddy's config but never reloads it: the caller's caddy_apply
# does, once. The caller sets CS_BASE_IMAGE (base-image.sh's answer, the
# same for both instances).
cs_install_instance() {
	install -d -m 0700 "$CS_ETC"
	install -m 0644 "$CS_APP/infra/seccomp/codespace.json" "$CS_ETC/seccomp.json"
	install -d -m 0755 /etc/caddy/conf.d "$CS_QUADLET_DIR"
	local quadlet site rc=0
	# Both are rendered aside: a failed rendering installs nothing. The site
	# replaces the installed one only when it differs (caddy_site), so that
	# the caller's one caddy_apply reloads Caddy only when needed
	# (infra/engine/lib.sh).
	quadlet=$(mktemp) || return 1
	site=$(mktemp) || { rm -f "$quadlet"; return 1; }
	cs_render "$CS_APP/deploy/quiz-codespace.container" > "$quadlet" || rc=$?
	[ "$rc" != 0 ] || cs_render "$CS_APP/deploy/Caddyfile" > "$site" || rc=$?
	[ "$rc" != 0 ] || install -m 0644 "$quadlet" "$CS_QUADLET_DIR/$CS_UNIT.container" || rc=$?
	[ "$rc" != 0 ] || caddy_site "$site" "/etc/caddy/conf.d/$CS_UNIT.caddy" || rc=$?
	rm -f "$quadlet" "$site"
	[ "$rc" = 0 ] || return "$rc"
	caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

# cs_env <KEY>: the value the instance's env file gives KEY (its last line
# wins), or nothing.
cs_env() {
	sed -n "s/^$1=//p" "$CS_ETC/env" 2>/dev/null | tail -n 1
}

# cs_base_pin [--version]: the release deploy/quiz-base.ref pins, as
# `<repository>@<digest>` (what runs), or with --version its `x.y.z` (what
# its io.quiz.base.version label must say); nothing while the file pins
# none. Fails, saying why, on a missing file, more than one release, or a
# line that is not `ghcr.io/heig-tin-info/quiz-base:<x.y.z>@sha256:<64 hex>`.
# The pin's one parser: the CI's quiz-base-latest job sources it too.
cs_base_pin() {
	local lines
	if [ ! -f "$CS_BASE_PIN" ]; then
		echo "deploy: $CS_BASE_PIN is missing" >&2
		return 1
	fi
	lines=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$CS_BASE_PIN" || true)
	[ -n "$lines" ] || return 0
	if [[ ! "$lines" =~ ^"$CS_BASE_REPO":([0-9]+\.[0-9]+\.[0-9]+)@(sha256:[0-9a-f]{64})$ ]]; then
		echo "deploy: $CS_BASE_PIN must hold one line $CS_BASE_REPO:<x.y.z>@sha256:<64 hex>, not: $(printf '%s' "$lines" | head -c 300)" >&2
		return 1
	fi
	if [ "${1:-}" = --version ]; then
		echo "${BASH_REMATCH[1]}"
	else
		echo "$CS_BASE_REPO@${BASH_REMATCH[2]}"
	fi
}

# cs_base_installed: the base image the instance's installed quadlet names,
# or nothing (no quadlet, or one from before ADR-146).
cs_base_installed() {
	[ -f "$CS_QUADLET_DIR/$CS_UNIT.container" ] || return 0
	sed -n 's/^Environment=CODESPACE_DEFAULT_IMAGE=//p' "$CS_QUADLET_DIR/$CS_UNIT.container" | tail -n 1
}

# --- delete in the pin PR (RUNBOOK.md §7, The first release) ---------------
# cs_base_legacy: what the instance ran before its quadlet named a base
# image, the image built on this VM before ADR-146: its env file's
# CODESPACE_DEFAULT_IMAGE, else its CODESPACE_IMAGE, else
# codespace/c-dev:4.137.0.
cs_base_legacy() {
	local image
	image="$(cs_env CODESPACE_DEFAULT_IMAGE)"
	image="${image:-$(cs_env CODESPACE_IMAGE)}"
	# Mirrors the portal's config.ts default, which production runs when its
	# env names no image.
	echo "${image:-codespace/c-dev:4.137.0}"
}
# --- end of the block to delete ---------------------------------------------

# cs_base_current: the base image the instance runs now, its quadlet's or
# (until the pin PR) cs_base_legacy's.
cs_base_current() {
	local image
	image=$(cs_base_installed)
	[ -n "$image" ] || image=$(cs_base_legacy)
	echo "$image"
}
