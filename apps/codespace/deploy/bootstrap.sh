#!/usr/bin/env bash
#
# Brings one portal instance into shape on the engine VM, as root, from the
# PRODUCTION checkout (/opt/quiz-runner, an approved commit) for both
# instances, IDEMPOTENT:
#   apps/codespace/deploy/bootstrap.sh <prod | staging>
#
# Once per instance, before its first deploy (RUNBOOK.md says when). It never
# overwrites what holds a secret: the instance's env file is written only
# when absent. It does NOT deploy the portal (the CI does, through
# infra/engine/deploy.sh) and builds no image.
#
#   1. checks: root, the rootful socket, the `containers` subordinate range
#   2. persistent br_netfilter (without it the ICC rule is inoperative)
#   3. /srv/quiz-codespace/<instance>/{var,volumes}, /etc/quiz-codespace/<instance>
#   4. /etc/quiz-codespace/<instance>/env from env.example, two secrets drawn
#   5. the host-level files (network scripts, nftables, AppArmor, units) and
#      the instance's (seccomp, quadlet, Caddy site), as a deploy installs them
#   6. the instance's network and shadow timer, enabled and started
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh

ok() { printf '  ok    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "bootstrap.sh must run as root"
cs_instance "${1:-}" || die "unknown instance '${1:-}' (prod | staging)"

step "checks"
systemctl is-active --quiet podman.socket || die "podman.socket is not active"
pd info >/dev/null || die "rootful Podman socket unreachable ($CS_PODMAN_URL)"
for f in /etc/subuid /etc/subgid; do
	grep -q '^containers:' "$f" || die "no 'containers' range in $f: --userns=auto cannot work"
done
command -v caddy >/dev/null || die "caddy is not installed"
grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile || die "/etc/caddy/Caddyfile does not import /etc/caddy/conf.d/*.caddy"
ok "socket, userns range, Caddy import"

step "persistent br_netfilter"
printf 'br_netfilter\n' > /etc/modules-load.d/quiz-codespace.conf
printf 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\n' \
	> /etc/sysctl.d/99-quiz-codespace-bridge.conf
modprobe br_netfilter
sysctl -qw net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1
ok "br_netfilter loaded, bridge-nf-call-ip{,6}tables = 1"

step "directories of $CS_INSTANCE"
install -d -m 0755 /srv/quiz-codespace /etc/quiz-codespace
install -d -m 0750 "$CS_DATA" "$CS_DATA/var" "$CS_DATA/volumes"
install -d -m 0700 "$CS_ETC"
install -d -m 0755 /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true
ok "$CS_DATA/{var,volumes}, $CS_ETC"

step "$CS_ETC/env"
if [ -f "$CS_ETC/env" ]; then
	ok "present: kept as is (it holds the secrets)"
else
	launch="$(openssl rand -hex 32)"
	cookie="$(openssl rand -hex 32)"
	umask 077
	sed -e "s|@PUBLIC_URL@|https://$CS_HOST|g" \
		-e "s|@PORT@|$CS_PORT|g" \
		-e "s|@PLATFORM_URL@|$CS_PLATFORM|g" \
		-e "s|@LAUNCH_SECRET@|$launch|g" \
		-e "s|@EXAM_COOKIE_SECRET@|$cookie|g" \
		apps/codespace/deploy/env.example > "$CS_ETC/env"
	umask 022
	unset launch cookie
	ok "written, with a fresh CODESPACE_LAUNCH_SECRET and EXAM_COOKIE_SECRET"
fi
chmod 0600 "$CS_ETC/env"
grep -q '@[A-Z_]*@' "$CS_ETC/env" && die "$CS_ETC/env still holds a @PLACEHOLDER@"
ok "$CS_ETC/env is $(stat -c '%a %U:%G' "$CS_ETC/env")"

step "host-level and instance files"
cs_install_host
cs_install_instance
systemctl daemon-reload
ok "$CS_LIB, units, /etc/containers/systemd/$CS_UNIT.container, /etc/caddy/conf.d/$CS_UNIT.caddy"

step "network and shadow timer of $CS_INSTANCE"
systemctl enable --now "quiz-codespace-net@$CS_INSTANCE.service" >/dev/null
systemctl enable --now "quiz-codespace-shadow@$CS_INSTANCE.timer" >/dev/null
ok "$CS_NET on $CS_IFACE, gateway $CS_GATEWAY; shadow timer $(systemctl is-active "quiz-codespace-shadow@$CS_INSTANCE.timer")"
systemctl reload caddy
ok "caddy reloaded ($CS_HOST -> 127.0.0.1:$CS_PORT)"

student="$(cs_student_image)"
if pd image exists "$student"; then
	ok "student image $student present"
else
	printf '  ..    student image %s missing: apps/codespace/images/build.sh\n' "$student"
fi

step "next"
printf '  the portal is not started until its first deploy (the image :%s does not exist yet)\n' "$CS_INSTANCE"
printf '  Quiz needs CODESPACE_URL=https://%s and the CODESPACE_LAUNCH_SECRET of %s/env\n' "$CS_HOST" "$CS_ETC"
