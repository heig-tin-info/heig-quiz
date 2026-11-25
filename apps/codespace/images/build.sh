#!/usr/bin/env bash
#
# Builds quiz-base, the workspace image, through the rootful socket:
#   apps/codespace/images/build.sh                       # localhost/quiz-base:dev
#   apps/codespace/images/build.sh <tag> [<podman build option>...]
#
# For development and for the CI (.github/workflows/quiz-base.yml, the only
# place a release is built and published). No deploy builds it, and the
# engine VM never does (ADR-146 §1): the portal's deploy pulls a release by
# digest (deploy/quiz-base.ref). The release labels (`--label`)
# come from quiz-base/VERSION and quiz-base/CONTRACT, the revision from git.
#
# 1.6 GB, one to two minutes on 2 vCPU. Then the acceptance tests:
#   quiz-base/test.sh <tag> && quiz-base/test-hardening.sh <tag> && quiz-base/test-toolchain.sh <tag>
# (APPARMOR= on a host without AppArmor), or all of it as the CI runs it:
# ci-test.sh. Only the CI's publish.sh names the image ghcr.io/….
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HERE/quiz-base"
VERSION="$(cat "$DIR/VERSION")"
CONTRACT="$(cat "$DIR/CONTRACT")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "build: VERSION is not x.y.z: '$VERSION'" >&2; exit 2; }
[[ "$CONTRACT" =~ ^[0-9]+$ ]] || { echo "build: CONTRACT is not an integer: '$CONTRACT'" >&2; exit 2; }
# The commit the image is built from; `-dirty` when quiz-base/ differs from
# it, which test.sh accepts only with QUIZ_BASE_ALLOW_UNKNOWN_REVISION=1.
REVISION="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$REVISION" != unknown ] && [ -n "$(git -C "$HERE" status --porcelain -- quiz-base)" ]; then
	REVISION="$REVISION-dirty"
fi
TAG="${1:-localhost/quiz-base:dev}"
[ $# -eq 0 ] || shift
PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
pd() { podman --remote --url "$PODMAN_URL" "$@"; }

t0=$(date +%s)
pd build -t "$TAG" --platform linux/amd64 \
	--label "io.quiz.base.version=$VERSION" \
	--label "io.quiz.base.contract=$CONTRACT" \
	--label "org.opencontainers.image.version=$VERSION" \
	--label "org.opencontainers.image.revision=$REVISION" \
	"$@" "$DIR"
echo "built $TAG (quiz-base $VERSION, contract $CONTRACT, ${REVISION:0:12}) in $(($(date +%s) - t0)) s"
