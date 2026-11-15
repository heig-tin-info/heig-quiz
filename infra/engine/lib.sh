# Shared by the engine VM's install steps (apps/runner/deploy/install.sh,
# apps/codespace/deploy/install.sh). Sourced, not executed; runs as root.
#
# shellcheck shell=bash

ENGINE_PODMAN_URL=unix:///run/podman/podman.sock
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The rootful engine, always through its socket (root invariant 13).
pd() { podman --remote --url "$ENGINE_PODMAN_URL" "$@"; }

# pull_retag <repository> <sha> <local tag>: pulls the CI's image of the sha
# and gives it the tag the quadlet runs (Pull=never: never the registry's
# moving tag). With QUIZ_DEPLOY_DIGEST (set by deploy.sh from the CI's
# request, audit M8) the pull is by that digest, the bytes the CI built, and
# the image ID the pull prints is tagged with the sha locally; without it,
# the pull is by the sha tag.
pull_retag() {
	local id
	if [ -n "${QUIZ_DEPLOY_DIGEST:-}" ]; then
		id=$(pd pull -q "$1@$QUIZ_DEPLOY_DIGEST")
		pd tag "$id" "$1:$2"
	else
		pd pull "$1:$2"
	fi
	pd tag "$1:$2" "$1:$3"
}

# install_slices: the two slices of the VM (M6-05), quiz-runner.slice and
# codespace.slice, into /etc/systemd/system/; the caller's daemon-reload
# applies a changed weight or limit to the running slice. A slice a unit
# names before its file exists is created empty by systemd, so the order of
# the deploys does not matter.
install_slices() {
	install -m 0644 "$ENGINE_DIR/quiz-runner.slice" "$ENGINE_DIR/codespace.slice" /etc/systemd/system/
}

# warn_manual_drift: a deploy never touches the host firewall, nor the frozen
# staging dispatcher; it only says when the checkout's host.nft or
# staging-dispatch.sh differs from the installed copy (or none is installed
# yet). Installing stays manual (nft-apply.sh, deployment.md §3; the
# dispatcher, deployment.md §4).
warn_manual_drift() {
	cmp -s "$ENGINE_DIR/host.nft" /etc/quiz-engine/host.nft \
		|| echo "deploy: warning: infra/engine/host.nft differs from the applied copy: run nft-apply.sh (deployment.md §3)" >&2
	cmp -s "$ENGINE_DIR/staging-dispatch.sh" /usr/local/libexec/quiz-engine/staging-dispatch.sh \
		|| echo "deploy: warning: infra/engine/staging-dispatch.sh differs from the installed copy: read the difference, then install it by hand (deployment.md §4, The frozen staging dispatcher)" >&2
}

# drop_old_sha_tags <repository> <sha to keep>: untags every other 40-hex
# tag of the repository, then deletes the repository's images no tag names
# any more. Never a global prune: other services and sessions share this
# engine.
#
# Untagging alone deletes nothing since the pull is by digest (pull_retag):
# the image keeps its `<repository>@sha256:…` name, shows as `<none>`, is
# not dangling, and `podman image prune` (without -a) keeps it. Hence the
# second loop, by image ID, on the IDs of the repository's `<none>` rows that
# have no tag left at all (RepoTags empty: `podman rmi <id>` deletes an image
# named by a single tag, so the check is not optional). An image that keeps
# any tag (:latest, :prod, :staging, the current sha), of any repository,
# stays: the prod and staging portals share this store and protect each
# other's image by their tag. Never `rmi -f`, which removes the containers
# using the image: an image in use refuses the rmi and stays.
drop_old_sha_tags() {
	local old id
	for old in $(pd images --format '{{.Tag}}' --filter "reference=$1" \
		| grep -E '^[0-9a-f]{40}$' | grep -vx "$2" | sort -u || true); do
		pd rmi "$1:$old" >/dev/null 2>&1 || true
	done
	for id in $(pd images --no-trunc --format '{{.ID}} {{.Tag}}' --filter "reference=$1" \
		| awk '$2 == "<none>" { print $1 }' | sort -u || true); do
		[ "$(pd image inspect --format '{{len .RepoTags}}' "$id" 2>/dev/null)" = 0 ] || continue
		pd rmi "$id" >/dev/null 2>&1 || true
	done
}
