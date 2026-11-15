#!/usr/bin/env bash
# Tests of infra/engine/lib.sh's drop_old_sha_tags against a stub podman
# that logs its argv: which names and which image IDs it removes, and that
# it never forces. No root, no Podman. Run by the CI's `checks` job, or:
#   bash infra/engine/lib.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
expect() {
	local name="$1"
	shift
	if "$@"; then
		printf 'ok    %s\n' "$name"
	else
		printf 'FAIL  %s\n' "$name" >&2
		failures=$((failures + 1))
	fi
}
not() { ! "$@"; }

repo=ghcr.io/heig-tin-info/quiz-codespace
keep_sha=0123456789abcdef0123456789abcdef01234567
old_sha=89abcdef0123456789abcdef0123456789abcdef
pd="podman --remote --url unix:///run/podman/podman.sock"

# The store, as `podman images` shows it after the untag loop: the kept
# sha's image (also :staging); prod's image, whose sha tag the loop just
# removed, still :prod; an image named by its digest only (deleted); the same
# with a running container (its rmi fails); an image whose `<none>` row
# hides a tag of another repository (kept).
bin="$work/bin"
mkdir -p "$bin"
cat > "$bin/podman" <<EOF
#!$(command -v bash)
printf 'podman %s\n' "\$*" >> "$work/log"
case " \$* " in
	*" images --format {{.Tag}} "*) printf '%s\n' $keep_sha staging prod $old_sha latest ;;
	*" images --no-trunc "*) printf '%s\n' \
		"sha256:aaaa $keep_sha" "sha256:aaaa staging" "sha256:bbbb prod" \
		"sha256:cccc <none>" "sha256:dddd <none>" "sha256:eeee <none>" "sha256:dddd <none>" ;;
	*" image inspect "*)
		case "\$*" in
			*sha256:cccc*|*sha256:dddd*) echo 0 ;;
			*) echo 1 ;;
		esac ;;
	*" rmi sha256:dddd"*) exit 2 ;;
esac
EOF
chmod +x "$bin/podman"

(
	# shellcheck source=lib.sh
	. "$here/lib.sh"
	PATH="$bin:$PATH"
	drop_old_sha_tags "$repo" "$keep_sha"
) > "$work/out" 2>&1
rc=$?

expect "exits 0, an rmi that fails included" [ "$rc" = 0 ]
expected="$pd images --format {{.Tag}} --filter reference=$repo
$pd rmi $repo:$old_sha
$pd images --no-trunc --format {{.ID}} {{.Tag}} --filter reference=$repo
$pd image inspect --format {{len .RepoTags}} sha256:cccc
$pd rmi sha256:cccc
$pd image inspect --format {{len .RepoTags}} sha256:dddd
$pd rmi sha256:dddd
$pd image inspect --format {{len .RepoTags}} sha256:eeee"
expect "untags the old sha, then removes by ID only what no tag names" \
	diff <(printf '%s\n' "$expected") "$work/log"
expect "never forces" not grep -qE ' rmi .*(-f|--force)' "$work/log"
expect "never prunes" not grep -q ' prune' "$work/log"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
