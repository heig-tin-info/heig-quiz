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
# moving tag).
pull_retag() {
	pd pull "$1:$2"
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

# warn_host_nft: a deploy never touches the host firewall; it only says when
# the checkout's host.nft differs from the applied copy (or none is applied
# yet). Applying stays manual (nft-apply.sh, deployment.md §3).
warn_host_nft() {
	cmp -s "$ENGINE_DIR/host.nft" /etc/quiz-engine/host.nft \
		|| echo "deploy: warning: infra/engine/host.nft differs from the applied copy: run nft-apply.sh (deployment.md §3)" >&2
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
