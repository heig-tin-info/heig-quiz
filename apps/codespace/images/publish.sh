#!/usr/bin/env bash
# Publishes a quiz-base build that passed its acceptance tests as the
# CANDIDATE quiz-base/VERSION names (ADR-146 §2, amendment of 2026-11-25):
# the last step of .github/workflows/quiz-base.yml on main, never anywhere
# else. It becomes a release once the approved production deploy has
# pinned, tested and switched to it (deploy/RUNBOOK.md §7).
#   GHCR_USER=<login> GHCR_TOKEN=<token> apps/codespace/images/publish.sh <local image>
#
# - ghcr.io/heig-tin-info/quiz-base:<VERSION> exists already: publishes
#   nothing (a tag is never overwritten; release-check.sh refused an image
#   change without a new VERSION).
# - Otherwise pushes the tested image as :<VERSION> and prints the line
#   deploy/quiz-base.ref takes, `…/quiz-base:<VERSION>@sha256:…`. The commit
#   is the image's org.opencontainers.image.revision label. `latest` is
#   never moved here.
#
# The existence check is curl's, with a token the GHCR credential buys;
# neither ever reaches an argv, a URL or the log (curl reads them from
# files). 200 is "exists", 404 "absent"; 401 or 403 asks the tag list (below).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
LOCAL="${1:?usage: publish.sh <local image>}"
: "${GHCR_USER:?}" "${GHCR_TOKEN:?}"
VERSION=$(tr -d '[:space:]' < apps/codespace/images/quiz-base/VERSION)
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "publish: VERSION is not x.y.z: '$VERSION'" >&2; exit 2; }
REPO=heig-tin-info/quiz-base
REF="ghcr.io/$REPO"
PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
pd() { podman --remote --url "$PODMAN_URL" "$@"; }

tmp=$(mktemp -d)
chmod 0700 "$tmp"
cleanup() {
	pd logout ghcr.io >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

printf 'user = "%s:%s"\n' "$GHCR_USER" "$GHCR_TOKEN" > "$tmp/basic"
body=$(curl -fsS -m 30 -K "$tmp/basic" "https://ghcr.io/token?service=ghcr.io&scope=repository:$REPO:pull,push") \
	|| { echo "publish: no registry token for $REPO (packages: write?)" >&2; exit 1; }
rm -f "$tmp/basic"
token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$body")
[ -n "$token" ] || { echo "publish: the registry gave no token for $REPO" >&2; exit 1; }
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$tmp/auth"
code=$(curl -sS -m 30 -I -o /dev/null -w '%{http_code}' -K "$tmp/auth" \
	-H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
	"https://ghcr.io/v2/$REPO/manifests/$VERSION")
case "$code" in
	200)
		echo "publish: $REF:$VERSION exists already: nothing published" >&2
		exit 0
		;;
	404) ;;
	401 | 403)
		# A package that does not exist yet may answer so, and so may a
		# credential that cannot read it: the tag list decides. Readable, the
		# tag is absent only if it is not listed; unreadable, the package does
		# not exist yet (and a broken credential fails the push, loudly).
		if tags=$(curl -fsS -m 30 -K "$tmp/auth" "https://ghcr.io/v2/$REPO/tags/list?n=10000" 2>/dev/null); then
			if grep -qF "\"$VERSION\"" <<<"$tags"; then
				echo "publish: $REF:$VERSION is listed already: nothing published" >&2
				exit 0
			fi
		fi
		;;
	*)
		echo "publish: cannot tell whether $REF:$VERSION exists (HTTP $code)" >&2
		exit 1
		;;
esac

printf '%s' "$GHCR_TOKEN" | pd login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
pd push --quiet --digestfile "$tmp/digest" "$LOCAL" "docker://$REF:$VERSION"
digest=$(tr -d '[:space:]' < "$tmp/digest")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "publish: no digest for $REF:$VERSION ('$digest')" >&2; exit 1; }
echo "$REF:$VERSION@$digest"
