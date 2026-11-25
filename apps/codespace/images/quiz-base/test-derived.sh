#!/usr/bin/env bash
# The contract check against images DERIVED from quiz-base (ADR-146 §5),
# as the portal will run it on a course image: one that allows one more
# extension passes; one that turns a protected setting off, or allows every
# extension, fails, naming the key. Each derived image is one layer that
# rewrites /etc/code-server/settings.json with code-server's node.
#
#   ./images/quiz-base/test-derived.sh [<image>]    # or IMAGE=
#
# It BUILDS images, so it runs on the CI and a workstation only, never on
# the engine VM (ADR-146 §1: no machine of the platform builds an image;
# deploy/base-image.sh runs the other three tests). The derived images are
# removed on exit. Prerequisites and APPARMOR=: test-lib.sh.
SUITE=derived
# shellcheck source=test-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"
DERIVED=()
trap 'cleanup; [ ${#DERIVED[@]} -eq 0 ] || podman_remote rmi "${DERIVED[@]}" >/dev/null 2>&1' EXIT

# The base's own check, the copy the portal runs.
podman_remote run --rm --network none --read-only --cap-drop=ALL --pull=never \
  --entrypoint cat "$IMAGE" /usr/local/lib/quiz-base/check > "${VOL_BASE}/check" \
  || fail "the image has no /usr/local/lib/quiz-base/check"

# derived <name> <JavaScript editing the settings object s>: builds the
# derived image localhost/quiz-base-derived:<name>.
derived() {
  local tag="localhost/quiz-base-derived:$1" ctx="${VOL_BASE}/ctx-$1"
  mkdir -p "$ctx"
  cat > "$ctx/Containerfile" <<'EOF'
ARG BASE
FROM $BASE
ARG EDIT
USER root
RUN /usr/lib/code-server/lib/node -e "const f = '/etc/code-server/settings.json'; \
      const fs = require('fs'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); \
      $EDIT; fs.writeFileSync(f, JSON.stringify(s, null, 2))"
USER 1000:1000
EOF
  DERIVED+=("$tag")
  podman_remote build -q --pull=never --build-arg "BASE=$IMAGE" --build-arg "EDIT=$2" \
    -t "$tag" "$ctx" >/dev/null || fail "could not build the derived image $1"
}

# check_on <name>: starts the derived image as a session would and runs the
# base's check (no --base: a course image's) in it; OUT holds its output.
check_on() {
  local ctr="qb-${SUITE}-$1"
  start "$ctr" "$1" "" "localhost/quiz-base-derived:$1"
  wait_healthz "$ctr"
  OUT=$(podman_remote exec -i "$ctr" sh -s < "${VOL_BASE}/check" 2>&1)
}

head2 "1. a course image may allow more extensions"
derived extension 's["extensions.allowed"]["golang.go"] = true; s["go.toolsManagement.autoUpdate"] = false'
check_on extension || fail "the check refused an image that allows one more extension" "$OUT"
ok "one more allowed extension and a language setting: the check passes"

head2 "2. it may not touch what protects the platform"
derived tasks 's["task.allowAutomaticTasks"] = "on"'
check_on tasks && fail "the check passed an image with automatic tasks on" "$OUT"
case "$OUT" in
  *"task.allowAutomaticTasks"*) ok "automatic tasks on: refused, the key named" ;;
  *) fail "the refusal does not name task.allowAutomaticTasks" "$OUT" ;;
esac

derived wildcard 's["extensions.allowed"]["*"] = true'
check_on wildcard && fail "the check passed an image that allows every extension" "$OUT"
case "$OUT" in
  *'extensions.allowed["*"]'*) ok "every extension allowed: refused" ;;
  *) fail "the refusal does not name extensions.allowed" "$OUT" ;;
esac

derived statusbar 'delete s["extensions.allowed"]["heig.codespace-statusbar"]'
check_on statusbar && fail "the check passed an image that disallows the status bar" "$OUT"
case "$OUT" in
  *"heig.codespace-statusbar"*) ok "the status-bar extension disallowed: refused" ;;
  *) fail "the refusal does not name heig.codespace-statusbar" "$OUT" ;;
esac

passed
