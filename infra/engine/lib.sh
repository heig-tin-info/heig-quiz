# Shared by the engine VM's install steps (apps/runner/deploy/install.sh,
# apps/codespace/deploy/install.sh). Sourced, not executed; runs as root.
#
# shellcheck shell=bash

ENGINE_PODMAN_URL=unix:///run/podman/podman.sock

# The rootful engine, always through its socket (root invariant 13).
pd() { podman --remote --url "$ENGINE_PODMAN_URL" "$@"; }

# pull_retag <repository> <sha> <local tag>: pulls the CI's image of the sha
# and gives it the tag the quadlet runs (Pull=never: never the registry's
# moving tag).
pull_retag() {
	pd pull "$1:$2"
	pd tag "$1:$2" "$1:$3"
}

# drop_old_sha_tags <repository> <sha to keep>: untags every other 40-hex
# tag of the repository. An image that keeps another tag (:latest, :prod,
# :staging) stays; one left with none and unused is deleted. Never a global
# prune: other services and sessions share this engine.
drop_old_sha_tags() {
	local old
	for old in $(pd images --format '{{.Tag}}' --filter "reference=$1" \
		| grep -E '^[0-9a-f]{40}$' | grep -vx "$2" | sort -u || true); do
		pd rmi "$1:$old" >/dev/null 2>&1 || true
	done
}
