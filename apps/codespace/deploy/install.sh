#!/usr/bin/env bash
#
# Deploys one instance of the portal on the engine VM, at the checkout's
# commit. Run by the dispatcher infra/engine/deploy.sh (as root, after the
# registry login and the checkout of the deployed sha):
#   apps/codespace/deploy/install.sh <prod | staging>
#
# 1. the live-session guard (prod only), 2. pull the CI's image of this sha
# and tag it :<instance>, the tag the quadlet runs, 3. install the host-level
# files (prod only) and the instance's files, 4. replay the instance's
# network setup, restart the portal and wait for its /healthz, 5. untag
# older sha tags. The student image is NOT touched: it is built on the VM on
# purpose (images/build.sh).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh

if ! cs_instance "${1:-}"; then
	echo "deploy: unknown codespace instance '${1:-}' (prod | staging)" >&2
	exit 2
fi
if [ ! -f "$CS_ETC/env" ]; then
	echo "deploy: $CS_ETC/env is missing: bootstrap the instance first (apps/codespace/deploy/RUNBOOK.md)" >&2
	exit 2
fi
tag="$(git rev-parse HEAD)"

# The live-session guard (RUNBOOK.md, The live-session guard): a prod
# restart keeps the student containers, but every open editor loses its
# connection for a few seconds, and an exam must not. Podman is asked, not
# the portal, so a portal that is down does not block its own repair; a
# `ps` that fails refuses like a live session. Staging is not guarded.
if [ "$CS_INSTANCE" = prod ]; then
	live=$(pd ps --filter label=heig-codespace.session \
		--filter "label=heig-codespace.instance=$CS_INSTANCE" \
		--filter status=running --format '{{.Names}}') \
		|| live="(podman ps failed: see the error above)"
	if [ -n "$live" ]; then
		{
			echo "deploy: codespace $CS_INSTANCE has running sessions:"
			printf '%s\n' "$live" | sed 's/^/  /'
		} >&2
		if [ -z "${QUIZ_DEPLOY_FORCE:-}" ]; then
			echo "deploy: REFUSED. Re-run the deploy job once they have closed, or force it (RUNBOOK.md, The live-session guard)." >&2
			exit 3
		fi
		echo "deploy: FORCED, restarting anyway." >&2
	fi
fi

pull_retag "$CS_IMAGE_REPO" "$tag" "$CS_INSTANCE"

# Host-level pieces from production's commits only (lib.sh says why, and
# what this does not protect against).
if [ "$CS_INSTANCE" = prod ]; then
	cs_install_host
fi
cs_install_instance
systemctl daemon-reload
# The git channel binds the bridge gateway and refuses to start without it
# (no 0.0.0.0 fallback for a named instance): replay the network setup,
# idempotent, so the bridge and its anchor exist before the portal starts.
systemctl restart "quiz-codespace-net@$CS_INSTANCE.service"
systemctl restart "$CS_UNIT.service"
systemctl reload caddy

# The exit code the CI receives is the instance's health.
port="$(sed -n 's/^PORT=//p' "$CS_ETC/env" | tail -n 1)"
for i in $(seq 1 60); do
	if curl -fsS -m 2 "http://127.0.0.1:${port:-$CS_PORT}/healthz" >/dev/null 2>&1; then
		break
	fi
	if [ "$i" = 60 ]; then
		echo "deploy: $CS_UNIT does not answer /healthz after 60 s" >&2
		journalctl -u "$CS_UNIT.service" -n 40 --no-pager >&2 || true
		exit 1
	fi
	sleep 1
done

student="$(cs_student_image)"
if ! pd image exists "$student"; then
	echo "deploy: warning: the student image $student is missing: no session can start (apps/codespace/images/build.sh)" >&2
fi

drop_old_sha_tags "$CS_IMAGE_REPO" "$tag"
echo "deploy: codespace $CS_INSTANCE at ${tag:0:7}"
