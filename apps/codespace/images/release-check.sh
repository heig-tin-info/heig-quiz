#!/usr/bin/env bash
# A change of what quiz-base is made of comes with a new VERSION (ADR-146 §2,
# quiz-base/README.md § Releasing): a published release is never rebuilt
# under its version. Run by .github/workflows/quiz-base.yml on a pull
# request (against its base) and on main (against the previous main):
#   apps/codespace/images/release-check.sh <base rev> [<head rev>]
# Exits 1, naming the files, when the image's inputs changed and VERSION
# did not, or when VERSION is not x.y.z or does not grow; prints the new
# version when there is one. The inputs are every file of quiz-base/ but
# the README and the acceptance tests, which the build does not read.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../../.."
DIR=apps/codespace/images/quiz-base
base="${1:?usage: release-check.sh <base rev> [<head rev>]}"
head="${2:-HEAD}"

# Nothing when the revision has no VERSION (before the first release).
version() { git show "$1:$DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || true; }
new=$(version "$head")
old=$(version "$base")
if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "release-check: $DIR/VERSION is not x.y.z: '$new'" >&2
	exit 1
fi

inputs=$(git diff --name-only "$base" "$head" -- "$DIR" \
	| grep -vE "^$DIR/(README\.md|test[^/]*\.sh|test-[^/]*\.js|run-hardened\.sh)\$" || true)

if [ "$new" = "$old" ]; then
	if [ -n "$inputs" ]; then
		{
			echo "release-check: these files change the image, but $DIR/VERSION is still $new:"
			printf '%s\n' "$inputs" | sed 's/^/  /'
			echo "bump VERSION (README.md § Releasing): a release is never rebuilt under its version"
		} >&2
		exit 1
	fi
	echo "release-check: quiz-base $new, image unchanged"
	exit 0
fi
# A first VERSION (none at the base) is a new release too.
if [ -n "$old" ] && [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -n 1)" != "$new" ]; then
	echo "release-check: $DIR/VERSION goes from $old down to $new" >&2
	exit 1
fi
echo "release-check: quiz-base ${old:-none} -> $new"
