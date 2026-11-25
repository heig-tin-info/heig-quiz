#!/usr/bin/env bash
# The CI's build and test of quiz-base, the same in both jobs of
# .github/workflows/quiz-base.yml (a GitHub-hosted Ubuntu runner, sudo
# without a password):
#   apps/codespace/images/ci-test.sh <local tag>
#
# 1. the rootful engine, as on the engine VM: the `containers`
#    subordinate range for --userns=auto (the Ubuntu package creates none),
#    the socket handed to the job's user so the scripts drive it with
#    `--remote` (runner-integration.yml does the same); 2. the sessions'
#    AppArmor profile; 3. a cold build (no layer cache, the bases pulled
#    again); 4. the four acceptance tests, the derived images' included.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
IMAGE="${1:?usage: ci-test.sh <local tag>}"
PODMAN_URL=unix:///run/podman/podman.sock
export PODMAN_URL
# test.sh is strict about the image's revision: never its workstation opt-in.
unset QUIZ_BASE_ALLOW_UNKNOWN_REVISION

podman --version
for f in /etc/subuid /etc/subgid; do
	grep -q '^containers:' "$f" || echo 'containers:2147483647:2147483648' | sudo tee -a "$f" >/dev/null
done
sudo systemctl start podman.socket
sudo chmod o+x /run/podman
sudo chown "$(id -u)" /run/podman/podman.sock
podman --remote --url "$PODMAN_URL" info --format '{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}} {{.Host.OCIRuntime.Name}}'

sudo install -m 0644 apps/codespace/infra/apparmor/codespace /etc/apparmor.d/codespace
sudo apparmor_parser -r /etc/apparmor.d/codespace

apps/codespace/images/build.sh "$IMAGE" --no-cache --pull=always

for t in test.sh test-hardening.sh test-toolchain.sh test-derived.sh; do
	echo "::group::$t"
	apps/codespace/images/quiz-base/"$t" "$IMAGE"
	echo "::endgroup::"
done
