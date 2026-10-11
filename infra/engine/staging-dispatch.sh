#!/usr/bin/env bash
# The FROZEN staging dispatcher of the engine VM, code.chevallier.io
# (ADR-016, amendment of 2026-10-11, security audit H4). root's
# authorized_keys pins the CI's STAGING key to this script, and to nothing
# else:
#   command="/usr/local/libexec/quiz-engine/staging-dispatch.sh",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
#
# Every commit of main reaches this VM through that key before anyone
# approves it, and the VM hosts the PRODUCTION runner and portal. So what
# the key runs must not come from the commit: this file is versioned here
# but INSTALLED ONCE by the operator, root-owned, mode 0755, in a directory
# only root may write (deployment.md §4, *The frozen staging dispatcher*),
# and no deploy ever rewrites it. It runs no file of any checkout (no git,
# no install.sh, nothing sourced) and writes no unit: it pulls the staging
# portal's image BY DIGEST, tags it, and restarts the staging quadlet, whose
# content is fixed on the VM (installed by bootstrap.sh from production's
# approved checkout). Changing this script, or the quadlet, is an operator's
# step, like the host firewall.
#
# The request, in $SSH_ORIGINAL_COMMAND, matched strictly and never eval'd:
#   codespace staging <sha> <digest> <token>
#     <sha>     40 lowercase hex: the commit, used as a NAME only (the local
#               tag :<sha>, for people and drop_old_sha_tags); never checked
#               out, never fetched
#     <digest>  sha256:<64 lowercase hex>, what the CI's image job pushed for
#               quiz-codespace; MANDATORY, the pull is never by tag
#     <token>   an ephemeral GHCR token ([A-Za-z0-9_]+), piped to
#               `podman login`, never on argv; root's auth file is under /run
# The words of infra/engine/deploy.sh's M6-04 form, with the digest
# mandatory and no `force` (staging has no live-session guard). Anything
# else exits 2 before the lock, the login or any engine call.
#
# Then, under the VM's deploy lock (shared with infra/engine/deploy.sh):
# log in, pull <repo>@<digest>, tag the pulled image :<sha> and :staging
# (the tag the quadlet runs, Pull=never), restart the instance's network
# unit and portal, wait for its /healthz (the CI's exit code), untag the
# repository's other sha tags (an image still tagged :prod or :staging
# stays). Idempotent: the same request twice ends in the same state.
#
# Exit codes: 0 deployed and healthy, 1 a step failed or no /healthz,
# 2 a refused request or an instance not set up, 4 the lock.
set -euo pipefail

# Fixed values, never from the request or the environment.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PODMAN_URL=unix:///run/podman/podman.sock
REPO=ghcr.io/heig-tin-info/quiz-codespace
INSTANCE=staging
UNIT=quiz-codespace-staging.service
NET_UNIT=quiz-codespace-net@staging.service
QUADLET=/etc/containers/systemd/quiz-codespace-staging.container
ENV_FILE=/etc/quiz-codespace/staging/env
HEALTH_URL=http://127.0.0.1:3120/healthz
LOCK=/run/quiz-engine-deploy.lock

# The rootful engine, always through its socket (root invariant 13).
pd() { podman --remote --url "$PODMAN_URL" "$@"; }

# parse_request <request>: sets sha, digest and token, or says why not and
# returns 1. The request is never echoed: it holds the token.
parse_request() {
	local re='^codespace[[:space:]]+staging[[:space:]]+([0-9a-f]{40})[[:space:]]+(sha256:[0-9a-f]{64})[[:space:]]+([A-Za-z0-9_]+)$'
	if [[ "$1" =~ $re ]]; then
		sha="${BASH_REMATCH[1]}"
		digest="${BASH_REMATCH[2]}"
		token="${BASH_REMATCH[3]}"
		return 0
	fi
	echo "staging-dispatch: malformed request (expected: codespace staging <sha> sha256:<digest> <token>)" >&2
	return 1
}

# drop_old_sha_tags: untags every other 40-hex tag of the repository. An
# image that keeps another tag (:prod, :staging, :latest) stays; one left
# with none and unused is deleted. Never a global prune.
drop_old_sha_tags() {
	local old
	for old in $(pd images --format '{{.Tag}}' --filter "reference=$REPO" \
		| grep -E '^[0-9a-f]{40}$' | grep -vx "$sha" | sort -u || true); do
		pd rmi "$REPO:$old" >/dev/null 2>&1 || true
	done
}

main() {
	local sha digest token id i f
	parse_request "${SSH_ORIGINAL_COMMAND:-}" || exit 2

	for f in "$QUADLET" "$ENV_FILE"; do
		if [ ! -f "$f" ]; then
			echo "staging-dispatch: $f is missing: the operator installs the staging instance first (deployment.md §4, The frozen staging dispatcher)" >&2
			exit 2
		fi
	done

	exec 9>"$LOCK"
	if ! flock -w 900 9; then
		echo "staging-dispatch: another deploy has held the engine VM for 15 minutes" >&2
		exit 4
	fi

	printf '%s' "$token" | pd login ghcr.io -u heig-tin-info --password-stdin >/dev/null
	unset token

	id=$(pd pull -q "$REPO@$digest")
	pd tag "$id" "$REPO:$sha"
	pd tag "$REPO:$sha" "$REPO:$INSTANCE"

	systemctl restart "$NET_UNIT"
	systemctl restart "$UNIT"

	for i in $(seq 1 60); do
		if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
			break
		fi
		if [ "$i" = 60 ]; then
			echo "staging-dispatch: $UNIT does not answer /healthz after 60 s" >&2
			journalctl -u "$UNIT" -n 40 --no-pager >&2 || true
			exit 1
		fi
		sleep 1
	done

	drop_old_sha_tags
	echo "staging-dispatch: codespace $INSTANCE at ${sha:0:7} ($digest)"
}

# Sourced by its test (staging-dispatch.test.sh), run by the forced command.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	main
fi
