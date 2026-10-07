#!/usr/bin/env bash
# Definitions shared by setup.sh, teardown.sh and test.sh (task P2).
# This file is sourced, not executed.
# shellcheck disable=SC2034,SC2317  # values read by the scripts that source it

# One closed network per portal instance (M6-04, CS_INSTANCE, the portal's
# CODESPACE_INSTANCE). `default` (a workstation) and `prod` are the original
# network; `staging`, the second portal of the engine VM, gets a bridge, a
# subnet and an anchor of its own, so that its containers can reach neither
# production's git channel nor production's containers
# (infra/nft/codespace.nft pins each bridge to its own gateway). A closed
# table: the bridges and gateways are also written in ../nft/*.nft, and must
# change together; deploy/lib.sh reads them from here.
case "${CS_INSTANCE:-default}" in
	default|prod)
		CS_NET=codespace
		CS_IFACE=cs0
		CS_SUBNET=10.77.0.0/24
		CS_GATEWAY=10.77.0.254
		CS_ANCHOR=codespace-anchor
		;;
	staging)
		CS_NET=codespace-staging
		CS_IFACE=cs1
		CS_SUBNET=10.77.1.0/24
		CS_GATEWAY=10.77.1.254
		CS_ANCHOR=codespace-staging-anchor
		;;
	*)
		echo "unknown CS_INSTANCE '${CS_INSTANCE}' (default | prod | staging)" >&2
		return 2 2>/dev/null || exit 2
		;;
esac
CS_GIT_PORT=9418
CS_CLOSED_PORT=9999            # control port: must stay unreachable
CS_ANCHOR_IMAGE=docker.io/library/alpine:3.20
CS_PODMAN_URL=unix:///run/podman/podman.sock

CS_NET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CS_NFT_DIR="$(cd "$CS_NET_DIR/../nft" && pwd)"

# Rootful Podman through the socket, ALWAYS. Without --remote the binary falls
# back to rootless local and everything below measures another network
# (setup-workstation.md). A function, not a variable: the author's shell is zsh.
pd() { podman --remote --url "$CS_PODMAN_URL" "$@"; }

cs_is_root() { [ "$(id -u)" -eq 0 ]; }

cs_sudo_hint() {
	echo "BLOCKED: run  sudo $CS_NET_DIR/setup.sh"
}
