#!/usr/bin/env bash
#
# Deploys the portal's PROD instance on the engine VM, at the checkout's
# commit. Run by the production dispatcher infra/engine/deploy.sh (as root,
# after the registry login and the checkout of an approved sha):
#   apps/codespace/deploy/install.sh prod
# The staging portal is deployed by infra/engine/staging-dispatch.sh, never
# from a checkout.
#
# 1. the live-session guard, 2. pull the CI's image of this sha and tag it
# :prod, the tag the quadlet runs, 3. choose the quiz-base release both
# instances run (base-image.sh, RUNBOOK.md §7: a newly pinned one is pulled
# anonymously and tested first, never beside a live session), then the
# live-session guard again (the tests take minutes), 4. install the
# host-level files and the instance's files, 5. replay the instance's
# network setup, restart the portal and wait for its /healthz, 6. write the
# staging instance's files, then reload Caddy once, only if it does not run
# what the files give, 7. untag older sha tags and delete the repository's
# images no tag names and no container uses. A release that failed its
# tests leaves the image in service and fails the deploy at the end, the
# portal deployed. The last line on standard output,
# `quiz-base-in-service: <image>`, names what the prod quadlet runs: the CI
# moves quiz-base:latest only when it is the pinned release.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
# shellcheck source=lib.sh
. apps/codespace/deploy/lib.sh

if [ "${1:-}" != prod ]; then
	echo "deploy: install.sh deploys the prod instance only, not '${1:-}' (staging: the frozen dispatcher, deployment.md §4)" >&2
	exit 2
fi
cs_instance "$1"
if [ ! -f "$CS_ETC/env" ]; then
	echo "deploy: $CS_ETC/env is missing: bootstrap the instance first (apps/codespace/deploy/RUNBOOK.md)" >&2
	exit 2
fi
tag="$(git rev-parse HEAD)"

# The live-session guard (RUNBOOK.md, The live-session guard): a prod
# restart keeps the student containers, but every open editor loses its
# connection for a few seconds, and an exam must not. Podman is asked, not
# the portal, so a portal that is down does not block its own repair; a
# `ps` that fails refuses like a live session. Sets `live`; returns 3
# unless the deploy is forced.
guard() {
	live=$(pd ps --filter label=heig-codespace.session \
		--filter "label=heig-codespace.instance=$CS_INSTANCE" \
		--filter status=running --format '{{.Names}}') \
		|| live="(podman ps failed: see the error above)"
	[ -n "$live" ] || return 0
	{
		echo "deploy: codespace $CS_INSTANCE has running sessions:"
		printf '%s\n' "$live" | sed 's/^/  /'
	} >&2
	if [ -z "${QUIZ_DEPLOY_FORCE:-}" ]; then
		echo "deploy: REFUSED. Re-run the deploy job once they have closed, or force it (RUNBOOK.md, The live-session guard)." >&2
		return 3
	fi
	echo "deploy: FORCED, restarting anyway." >&2
}
guard || exit 3

# The portal image the quadlet runs now. Any failing exit between the
# retag and the portal's restart gives its tag back: a later restart (a
# crash, a reboot) must not run this commit's portal under the previous
# commit's files. Once the restart is issued, the new pair is in service
# and the trap is dropped.
previous=$(pd image inspect --format '{{.Id}}' "$CS_IMAGE_REPO:$CS_INSTANCE" 2>/dev/null || true)
restore_portal() {
	local rc=$?
	if [ "$rc" != 0 ] && [ -n "$previous" ]; then
		pd tag "$previous" "$CS_IMAGE_REPO:$CS_INSTANCE" \
			&& echo "deploy: failed (exit $rc) before the restart: :$CS_INSTANCE names the portal in service again" >&2
	fi
}
trap restore_portal EXIT
pull_retag "$CS_IMAGE_REPO" "$tag" "$CS_INSTANCE"

# The quiz-base release of both instances, on standard output; what it did
# on standard error. Exit 1 still names the image in service.
base_rc=0
CS_BASE_IMAGE=$(apps/codespace/deploy/base-image.sh ${live:+--defer}) || base_rc=$?
if [ -z "$CS_BASE_IMAGE" ]; then
	echo "deploy: base-image.sh named no image (exit $base_rc): nothing installed" >&2
	exit 1
fi
# A session may have started during the tests: the guard again, right
# before anything is installed or restarted. Forced past one, a new release
# waits for the next deploy, as base-image.sh --defer would have.
if [ -z "$live" ]; then
	guard || exit 3
	if [ -n "$live" ] && [ "$CS_BASE_IMAGE" != "$(cs_base_current)" ]; then
		CS_BASE_IMAGE=$(cs_base_current)
		echo "deploy: a session started during the base image's tests: $CS_BASE_IMAGE stays, the next deploy switches" >&2
	fi
fi

# Host-level pieces, then the instance's (lib.sh).
cs_install_host
cs_install_instance
systemctl daemon-reload
# The git channel binds the bridge gateway and refuses to start without it
# (no 0.0.0.0 fallback for a named instance): replay the network setup,
# idempotent, so the bridge and its anchor exist before the portal starts.
systemctl restart "quiz-codespace-net@$CS_INSTANCE.service"
systemctl restart "$CS_UNIT.service"
trap - EXIT

# The exit code the CI receives is the instance's health.
for i in $(seq 1 60); do
	if curl -fsS -m 2 "http://127.0.0.1:$CS_PORT/healthz" >/dev/null 2>&1; then
		break
	fi
	if [ "$i" = 60 ]; then
		echo "deploy: $CS_UNIT does not answer /healthz after 60 s" >&2
		journalctl -u "$CS_UNIT.service" -n 40 --no-pager >&2 || true
		exit 1
	fi
	sleep 1
done

# The staging instance's quadlet, Caddy site and seccomp profile, from this
# approved commit: no staging deploy writes them (infra/engine/
# staging-dispatch.sh); its next restart picks them up. Skipped until the
# staging instance is bootstrapped. cs_instance rebinds CS_*: the test in a
# subshell, the install in this shell (caddy_site records a change in it),
# this deploy's instance bound again after it.
if (cs_instance staging && [ -f "$CS_ETC/env" ]); then
	cs_instance staging
	cs_install_instance
	cs_instance "$1"
	systemctl daemon-reload
fi

# One Caddy reload for both sites, and only when Caddy does not run what the
# files give (infra/engine/lib.sh, caddy_apply).
caddy_apply

drop_old_sha_tags "$CS_IMAGE_REPO" "$tag"
echo "deploy: codespace $CS_INSTANCE at ${tag:0:7}, base image $CS_BASE_IMAGE"
# What the prod quadlet runs, read back from it: the CI's quiz-base-latest
# job moves `latest` only when this is the pinned release.
echo "quiz-base-in-service: $(cs_base_installed)"

if [ "$base_rc" != 0 ]; then
	echo "deploy: the portal is deployed, but the pinned quiz-base release was not switched to (above; RUNBOOK.md §7)" >&2
	exit 1
fi
