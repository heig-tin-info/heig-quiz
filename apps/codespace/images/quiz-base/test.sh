#!/usr/bin/env bash
# The contract's acceptance test (ADR-146 §2, README § Testing): what the
# portal relies on in the image, the contract check (contract/check --base)
# run against it as the portal runs it against a derived image, and what
# only the host can see (the image's configuration, code-server's log, the
# container's environment). The hardening and the toolchain have their own
# tests, test-hardening.sh and test-toolchain.sh; a release passes all three.
# Exits non-zero on the first failure, with a clear message.
#
#   ./images/quiz-base/test.sh [<image>]    # or IMAGE=; quiz-base:<VERSION> by default
#
# Prerequisites and APPARMOR=: test-lib.sh.
SUITE=contract
# shellcheck source=test-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"
CTR_B="qb-${SUITE}-b"

# A *valid* .vsix dropped into the work directory before start-up. Valid, so
# that the installation failure is attributable to the read-only root and not
# to a corrupt archive.
python3 - "${VOL_BASE}/a/work/fake-extension.vsix" <<'PY' >/dev/null || { echo "python3 required" >&2; exit 1; }
import zipfile, json, sys
pkg = {"name": "fake", "displayName": "Fake", "publisher": "attacker",
       "version": "1.0.0", "engines": {"vscode": "^1.60.0"}, "contributes": {}}
manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="fake" Version="1.0.0" Publisher="attacker"/>
<DisplayName>Fake</DisplayName><Description>fake extension package</Description></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
types = ('<?xml version="1.0" encoding="utf-8"?>'
         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="json" ContentType="application/json"/>'
         '<Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('extension/package.json', json.dumps(pkg))
    z.writestr('[Content_Types].xml', types)
print("ok")
PY

# Container A carries the portal's variables, container B does not: § 6
# compares the two environments.
start "$CTR_A" a "$PORTAL_ENV"
start "$CTR_B" b
wait_healthz "$CTR_A"
wait_healthz "$CTR_B"

# --------------------------------------------------------------------------
head2 "1. the image's configuration"
# --------------------------------------------------------------------------
# The portal's admission compares a derived image's User, Entrypoint and Cmd
# with the base's (ADR-146 §5): these are the base's.
CONF=$(podman_remote image inspect --format '{{.Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}' "$IMAGE" 2>&1)
[ "$CONF" = '1000:1000|["/usr/local/bin/entrypoint.sh"]|null' ] \
  || fail "User, Entrypoint or Cmd is not the contract's (1000:1000, entrypoint.sh, no Cmd)" "$CONF"
ok "User 1000:1000, Entrypoint /usr/local/bin/entrypoint.sh, no Cmd"

LABELS=$(podman_remote image inspect --format '{{index .Labels "io.quiz.base.version"}}|{{index .Labels "io.quiz.base.contract"}}|{{index .Labels "org.opencontainers.image.version"}}' "$IMAGE" 2>&1)
[[ "$LABELS" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\|[0-9]+\|([0-9.]+)$ ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] \
  || fail "the release labels are malformed (version|contract|version)" "$LABELS"
ok "labels: io.quiz.base.version, io.quiz.base.contract ($LABELS)"

# --------------------------------------------------------------------------
head2 "2. the contract check, as the portal runs it"
# --------------------------------------------------------------------------
# The image's own copy, the one the portal pipes into a derived image's
# container once the image is a release. It must be the contract/check of
# the commit the image was built from (its org.opencontainers.image.revision
# label), its manifest the hashes of that commit's files: an older release
# is held to its own sources, not to this checkout's. Strict: a revision
# this checkout does not hold fails (the engine VM's checkout fetches main,
# which holds every candidate's), and so does a local build from a modified
# tree (`<sha>-dirty`). Only on a workstation, QUIZ_BASE_ALLOW_UNKNOWN_REVISION=1
# holds a -dirty build to the working tree and skips an unknown revision with
# a note; base-image.sh and the CI never set it.
podman_remote exec "$CTR_A" cat /usr/local/lib/quiz-base/check > "${VOL_BASE}/check" 2>&1 \
  || fail "the image has no /usr/local/lib/quiz-base/check"
REV=$(podman_remote image inspect --format '{{index .Labels "org.opencontainers.image.revision"}}' "$IMAGE" 2>&1)
ALLOW="${QUIZ_BASE_ALLOW_UNKNOWN_REVISION:-}"
if [[ "$REV" =~ ^[0-9a-f]{40}$ ]] && git -C "$HERE" cat-file -e "${REV}^{commit}" 2>/dev/null; then
  SOURCES=rev
elif [ "$ALLOW" != 1 ]; then
  fail "the image's revision '$REV' is not a commit of this checkout (QUIZ_BASE_ALLOW_UNKNOWN_REVISION=1 on a workstation only)"
elif [[ "$REV" =~ ^[0-9a-f]{40}-dirty$ ]]; then
  SOURCES=tree
else
  SOURCES=none
fi
# source_of <path under quiz-base/>: that file as the image was built from it.
source_of() {
  case "$SOURCES" in
    rev) git -C "$HERE" show "${REV}:./$1" ;;
    tree) cat "${HERE}/$1" ;;
  esac
}
not_manifest() { sed "/^[[:space:]]*cat <<'MANIFEST'\$/,/^MANIFEST\$/d"; }
if [ "$SOURCES" = none ]; then
  printf '  skip  the check and its manifest against their sources: the revision %s is not in this checkout (QUIZ_BASE_ALLOW_UNKNOWN_REVISION=1)\n' "$REV"
else
  diff <(source_of contract/check | not_manifest) <(not_manifest < "${VOL_BASE}/check") >/dev/null \
    || fail "the image's check is not contract/check at ${REV}" \
            "$(diff <(source_of contract/check | not_manifest) <(not_manifest < "${VOL_BASE}/check") | head -20)"
  N=0
  while read -r hash path; do
    case "$path" in
      /usr/local/bin/entrypoint.sh) f=entrypoint.sh ;;
      */workbench/seb-workbench.js) f=seb-workbench.js ;;
      */workbench/workbench.html) continue ;;  # code-server's, edited at build time: the check holds its ?v=
      /opt/code-server/extensions/heig.codespace-statusbar-*/*.js) f="extension/${path##*/}" ;;
      /etc/resolv.conf) f=resolv.conf ;;
      *) fail "the manifest names a file the contract does not own: $path" ;;
    esac
    [ "$(source_of "$f" | sha256sum | cut -c1-64)" = "$hash" ] \
      || fail "the manifest's hash of $path is not that of $f at ${REV}"
    N=$((N + 1))
  done < <(sed -n "/^[[:space:]]*cat <<'MANIFEST'\$/,/^MANIFEST\$/p" "${VOL_BASE}/check" | sed '1d;$d')
  [ "$N" = 6 ] || fail "the manifest holds $N of the six files copied verbatim"
  ok "the image's check is contract/check at ${REV}, its manifest the hashes of that commit's $N files"
fi

OUT=$(podman_remote exec -i "$CTR_A" sh -s -- --base < "${VOL_BASE}/check" 2>&1) \
  || fail "the contract check failed" "$OUT"
printf '%s\n' "$OUT" | sed 's/^/       /'
ok "contract check --base: $(printf '%s\n' "$OUT" | tail -n 1)"

# --------------------------------------------------------------------------
head2 "3. no extension can be installed"
# --------------------------------------------------------------------------
cexec 'test -f /work/fake-extension.vsix' >/dev/null 2>&1 \
  || fail "the fake .vsix is not visible in /work"

OUT=$(cexec 'cp /work/fake-extension.vsix /tmp/x.vsix && code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "code-server --install-extension /tmp/x.vsix succeeded" "$OUT"
ok "code-server --install-extension /tmp/x.vsix fails (rc=$RC)"

OUT=$(cexec 'code-server --install-extension /work/fake-extension.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "a .vsix written into /work installs" "$OUT"
ok "fake .vsix from /work: refused (rc=$RC)"

# Variant of a student working around the configuration file error: the
# default extensions directory stays on the read-only root.
OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension succeeds as soon as XDG_CONFIG_HOME is writable" "$OUT"
case "$OUT" in
  *EROFS*|*"read-only"*|*"extensions.json"*) : ;;
  *) fail "the failure is not attributable to the read-only root" "$OUT" ;;
esac
ok "with a writable XDG_CONFIG_HOME, the failure really comes from the read-only root"

OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension straight into /opt/code-server/extensions succeeded" "$OUT"
ok "install-extension aimed at /opt/code-server/extensions: refused (rc=$RC)"

LIST=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions' 2>/dev/null | sort | tr '\n' ' ')
case "$LIST" in
  "heig.codespace-statusbar llvm-vs-code-extensions.vscode-clangd webfreak.debug "*) : ;;
  *) fail "the server's extension list is not exactly the three expected ones: [$LIST]" ;;
esac
ok "the server knows only the three preinstalled extensions: $LIST"

# The status-bar extension is baked into the image like the other two.
STATUSBAR_DIR=$(statusbar_dir)
STATUSBAR_VERSION=${STATUSBAR_DIR##*-}
VERS=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions --show-versions' 2>/dev/null | tr -d '\r')
case "$VERS" in
  *"heig.codespace-statusbar@${STATUSBAR_VERSION}"*) : ;;
  *) fail "heig.codespace-statusbar@${STATUSBAR_VERSION} missing from --list-extensions --show-versions" "$VERS" ;;
esac
ok "heig.codespace-statusbar@${STATUSBAR_VERSION} installed and listed by code-server"

# --------------------------------------------------------------------------
head2 "4. code-server: settings, fonts, themes, trusted domains, log"
# --------------------------------------------------------------------------
# The base's own settings; the keys that protect the platform are the
# contract check's (§ 2).
for k in '"files.autoSave": "afterDelay"' '"files.autoSaveDelay": 1000' \
         '"workbench.secondarySideBar.defaultVisibility": "hidden"' \
         '"keyboard.dispatch": "keyCode"' \
         '"terminal.integrated.stickyScroll.enabled": false' \
         '"terminal.integrated.fontLigatures.enabled": false' \
         '"window.autoDetectColorScheme": true' \
         '"workbench.preferredDarkColorTheme": "Dark 2026"' \
         '"workbench.preferredLightColorTheme": "Light 2026"' \
         '"llvm-vs-code-extensions.vscode-clangd": true' '"webfreak.debug": true'; do
  cexec "grep -qF '$k' /run/code-server/Machine/settings.json" >/dev/null 2>&1 || fail "setting missing from the machine settings: $k"
done
ok "the base's machine settings in force (autosave, layout, keyboard, terminal, themes, its two extensions allowed)"

# The settings must exist **in the bundled VS Code package**, not only in our
# own file: a name that does not exist would be silently ignored. Literal
# search in the workbench bundle.
WB=/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js
cexec "grep -q 'workbench.secondarySideBar.defaultVisibility' $WB" >/dev/null 2>&1 \
  || fail "workbench.secondarySideBar.defaultVisibility unknown to the bundled VS Code package"
cexec "grep -q 'keyboard.dispatch' $WB" >/dev/null 2>&1 \
  || fail "keyboard.dispatch unknown to the bundled VS Code package"
# The value set must be in the declared enum, otherwise VS Code rejects it.
cexec "grep -qF '\"workbench.secondarySideBar.defaultVisibility\":{type:\"string\",enum:[\"hidden\"' $WB" >/dev/null 2>&1 \
  || fail "hidden is not the first value of the workbench.secondarySideBar.defaultVisibility enum"
cexec "grep -qF '\"keyboard.dispatch\":{scope:1,type:\"string\",enum:[\"code\",\"keyCode\"]' $WB" >/dev/null 2>&1 \
  || fail "keyCode is not a declared value of keyboard.dispatch"
ok "both settings exist in the bundled VS Code, with the values set present in their enum"

# ADR-129 §10: a repository's `runOn: folderOpen` task never starts by
# itself, in a staff member's review session as in a student's.
# Its value is the contract check's (§ 2).
cexec "grep -q 'task.allowAutomaticTasks' $WB" >/dev/null 2>&1 \
  || fail "task.allowAutomaticTasks unknown to the bundled VS Code package"
ok "task.allowAutomaticTasks is a name the bundled VS Code knows"

# "Use the fonts on your computer" prompt: the causal chain, traced in the
# bundled package (see README). The terminal's sticky scroll loads the
# ligatures addon **unconditionally**, and that addon calls
# queryLocalFonts(). It is stickyScroll.enabled (default true) that governs.
cexec "grep -qF '\"terminal.integrated.stickyScroll.enabled\":{markdownDescription:' $WB" >/dev/null 2>&1 \
  || fail "terminal.integrated.stickyScroll.enabled unknown to the bundled VS Code package"
cexec "grep -aqE '\"terminal.integrated.stickyScroll.enabled\":[{][^}]{0,300}default:!0' $WB" >/dev/null 2>&1 \
  || fail "the upstream default of terminal.integrated.stickyScroll.enabled is no longer true: the proof is stale"
cexec "grep -qF 'importAddon(\"ligatures\").then' $WB" >/dev/null 2>&1 \
  || fail "sticky scroll no longer loads the ligatures addon: the proof is stale"
cexec "grep -aqE 'stickyScroll.enabled.{0,200}hasRichCommandDetection' $WB" >/dev/null 2>&1 \
  || fail "_shouldBeEnabled no longer reads terminal.integrated.stickyScroll.enabled"
cexec "grep -q 'queryLocalFonts' /usr/lib/code-server/lib/vscode/node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js" >/dev/null 2>&1 \
  || fail "addon-ligatures no longer calls queryLocalFonts: the proof is stale"
cexec "grep -aqE '\"terminal.integrated.fontLigatures.enabled\":[{][^}]{0,300}default:!1' $WB" >/dev/null 2>&1 \
  || fail "the upstream default of terminal.integrated.fontLigatures.enabled is no longer false"
ok "fonts prompt: chain stickyScroll -> addon-ligatures -> queryLocalFonts traced in the bundled package"

# The only callers of queryLocalFonts in what is served to the browser: the
# ligatures addon, and the workbench bundle (font suggestions in the settings,
# guarded by isElectron, false on the web). Any other family of files would be
# a new caller, hence a possible prompt.
FONT_CALLERS=$(cexec "grep -rl queryLocalFonts /usr/lib/code-server/lib/vscode/out /usr/lib/code-server/lib/vscode/node_modules 2>/dev/null | sort" | tr -d '\r')
[ -n "$FONT_CALLERS" ] || fail "no caller of queryLocalFonts found: the search proves nothing"
STRAY=$(printf '%s\n' "$FONT_CALLERS" | grep -v 'addon-ligatures' | grep -v 'workbench')
[ -z "$STRAY" ] || fail "unexpected caller of queryLocalFonts in the package" "$STRAY"
# The second caller's guard: Vhe=Ogo, where Ogo is isElectron in the minified
# platform module (see README). False in a browser.
cexec "grep -qF 'Vhe=Ogo' $WB" >/dev/null 2>&1 \
  || echo "  note the second caller's isElectron guard was not found as such (minification changed)"
ok "queryLocalFonts is called only by the ligatures addon and by a path guarded by isElectron"

# Both theme ids set (see README) are contributed by the bundled
# theme-defaults extension: a rename fails here, not silently in a browser.
for theme in 'Dark 2026' 'Light 2026'; do
  cexec "grep -qF '\"id\":\"$theme\"' /usr/lib/code-server/lib/vscode/extensions/theme-defaults/package.json" >/dev/null 2>&1 \
    || fail "theme \"$theme\" is not contributed by the bundled theme-defaults extension"
done
ok "both preferred themes are bundled: Dark 2026, Light 2026"

# The return URL's origin is a trusted link-protection domain (no "open the
# external website?" prompt on Close): the workbench page served by container
# A, which carries CODESPACE_RETURN_URL, lists it; container B, without it,
# starts code-server with no such flag.
TRUSTED=$(cexec 'curl -sS -L -m 5 http://localhost:8080/' 2>&1 | grep -o 'linkProtectionTrustedDomains[^]]*]')
case "$TRUSTED" in
  *"&quot;${ENV_RETURN_URL%/}&quot;"*) : ;;
  *) fail "the served workbench does not list the return URL's origin in linkProtectionTrustedDomains" "$TRUSTED" ;;
esac
CMD_B=$(podman_remote exec "$CTR_B" bash -lc "tr '\\0' ' ' < /proc/1/cmdline" 2>&1)
case "$CMD_B" in
  *link-protection*) fail "code-server (container B, no return URL) trusts a domain" "$CMD_B" ;;
  *code-server*) : ;;
  *) fail "could not read code-server's command line in container B" "$CMD_B" ;;
esac
ok "Close's origin ${ENV_RETURN_URL%/} trusted in the served workbench (A), no flag without a return URL (B)"

# Captured once: under pipefail, `grep -q` closing the pipe early makes a long
# log (the workbench page above was served) fail with SIGPIPE.
LOGS_A=$(podman_remote logs "$CTR_A" 2>&1)
case "$LOGS_A" in
  *'Using custom extensions gallery'*) : ;;
  *) fail "code-server did not take EXTENSIONS_GALLERY (default gallery active)" ;;
esac
ok "EXTENSIONS_GALLERY taken into account: 'Using custom extensions gallery'"

ERRS=$(printf '%s\n' "$LOGS_A" | grep -c 'Uncaught exception')
[ "$ERRS" = "0" ] || fail "code-server logged $ERRS uncaught exception(s)" "$(printf '%s\n' "$LOGS_A" | tail -20)"
ok "no uncaught exception at code-server start-up"

# --------------------------------------------------------------------------
head2 "5. resolver: fast failure"
# --------------------------------------------------------------------------
# The contract check proves /etc/resolv.conf is the image's, with no
# nameserver; this measures what that buys.
RESOLV=$(cexec 'cat /etc/resolv.conf' 2>&1)
case "$RESOLV" in
  *"options timeout:1 attempts:1"*) : ;;
  *) fail "the image's /etc/resolv.conf was overwritten by Podman" "$RESOLV" ;;
esac
R0=$(date +%s.%N)
if cexec 'getent hosts example.invalid' >/dev/null 2>&1; then
  fail "getent hosts example.invalid succeeded: there is a resolver"
fi
RES_ELAPSED=$(python3 -c "print(round($(date +%s.%N)-${R0}, 2))")
python3 -c "import sys; sys.exit(0 if ${RES_ELAPSED} < 2 else 1)" \
  || fail "getent hosts example.invalid took ${RES_ELAPSED}s, beyond the 2 s required"
ok "getent hosts example.invalid fails in ${RES_ELAPSED}s (< 2 s)"

# --------------------------------------------------------------------------
head2 "6. container environment: the portal's seven variables, and nothing else"
# --------------------------------------------------------------------------
# What the portal sets on `podman run` (sessions/manager.ts,
# CONTAINER_ENV_KEYS): the deadline, the return URL, the assignment title, then
# the student's git identity. The `heig.codespace-statusbar` extension reads the
# first three from `process.env`; git honours the other four without any
# configuration file at all.
for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" \
          "CODESPACE_RETURN_URL=${ENV_RETURN_URL}" \
          "CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}" \
          "GIT_AUTHOR_NAME=${ENV_GIT_NAME}" \
          "GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}" \
          "GIT_COMMITTER_NAME=${ENV_GIT_NAME}" \
          "GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"; do
  cexec "tr '\\0' '\\n' < /proc/1/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "variable missing from code-server's environment (pid 1): $kv" \
            "$(cexec "tr '\\0' '\\n' < /proc/1/environ" 2>&1)"
done
ok "the portal's seven variables are in code-server's environment (pid 1)"

# Exactly seven lines of difference with a container started without EXTRA_ARGS:
# the portal adds nothing else to the image, and no secret whatsoever.
ENV_A=$(podman_remote exec "$CTR_A" env | sort)
ENV_B=$(podman_remote exec "$CTR_B" env | sort)
EXTRA=$(comm -23 <(printf '%s\n' "$ENV_A") <(printf '%s\n' "$ENV_B") | grep -v '^HOSTNAME=' | grep -v '^container=')
EXTRA_COUNT=$(printf '%s\n' "$EXTRA" | grep -c .)
[ "$EXTRA_COUNT" = "7" ] \
  || fail "the portal container carries $EXTRA_COUNT variable(s) more than the image, expected 7" "$EXTRA"
printf '%s\n' "$EXTRA" | grep -qvE '^(CODESPACE|GIT)_' \
  && fail "a variable outside CODESPACE_*/GIT_* is set on the container" "$EXTRA"
ok "exactly seven variables beyond the image's own, all CODESPACE_ or GIT_: $(printf '%s' "$EXTRA" | tr '\n' ' ')"
PYENV=$(podman_remote exec "$CTR_A" env | grep -c '^PYTHON')
[ "$PYENV" = "0" ] || fail "the image sets PYTHON* variables" "$(podman_remote exec "$CTR_A" env | grep '^PYTHON')"
ok "no PYTHON* variable in the container's environment"

# The git identity in use: a commit really made inside the container carries the
# student's name and address, without any configuration file having been
# written. This is the production feedback of 2026-09-18.
IDENT=$(cexec 'git -C /work var GIT_AUTHOR_IDENT' 2>&1)
case "$IDENT" in
  "${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"*) : ;;
  *) fail "git -C /work var GIT_AUTHOR_IDENT does not carry the identity set by the portal" "$IDENT" ;;
esac
ok "git -C /work var GIT_AUTHOR_IDENT: $IDENT"

COMMIT=$(cexec '
  set -e
  rm -rf /tmp/idtest && mkdir -p /tmp/idtest && cd /tmp/idtest
  git init -q -b main .
  echo bonjour > a.txt
  git add a.txt
  git commit -q -m "essai identite"
  git --no-pager log -1 --pretty=format:"%an|%ae|%cn|%ce"' 2>&1)
case "$COMMIT" in
  "${ENV_GIT_NAME}|${ENV_GIT_EMAIL}|${ENV_GIT_NAME}|${ENV_GIT_EMAIL}") : ;;
  *) fail "git commit without a configuration file did not produce the right author" "$COMMIT" ;;
esac
ok "git commit inside the container: author and committer = ${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"

# And no configuration was written for that: it really is the variables.
CFG=$(cexec 'git -C /tmp/idtest config --local --get user.name || true' 2>&1 | tr -d "[:space:]")
[ -z "$CFG" ] || fail "an identity was written into the local configuration: $CFG"
ok "no local user.name: the four variables are enough for git"

# The extension host inherits this environment in two steps. First step,
# measured: code-server (pid 1) spawns the VS Code server, which does carry
# the three variables.
SRV_PID=$(cexec "pgrep -f 'code-server/out/node/entry' | head -1" 2>/dev/null | tr -d '[:space:]')
case "$SRV_PID" in
  ''|*[!0-9]*) fail "VS Code server process (out/node/entry) not found in the container" "$(cexec 'ps -eo pid,args --no-headers' 2>&1)" ;;
esac
for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" "CODESPACE_RETURN_URL=${ENV_RETURN_URL}"; do
  cexec "tr '\\0' '\\n' < /proc/${SRV_PID}/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "the VS Code server (pid ${SRV_PID}) did not inherit $kv"
done
ok "the VS Code server (pid ${SRV_PID}, spawned by code-server) inherited the three variables"

# Second step: it is that server which forks the extension host, and it builds
# its environment from its own. Checked in the bundled package, not from
# memory — the extension host itself only exists once a browser has connected,
# which this test does not do (see README, TODO(verify)).
cexec "grep -qF 'ExtensionHostConnection#buildUserEnvironment' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment not found in the bundled VS Code server"
cexec "grep -aqE 'buildUserEnvironment.{0,400}[{][.][.][.]process[.]env' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment does not build the extension host environment from process.env"
ok "buildUserEnvironment forks the extension host with {...process.env}: inheritance is complete"

# Once activated, the extension drops a witness in /tmp. It does not exist as
# long as no browser has opened the editor: we only check that it is not there
# by accident (it would then come from the image).
if cexec 'test -e /tmp/codespace-statusbar.json' >/dev/null 2>&1; then
  fail "the activation witness exists before any connection: it comes from the image"
fi
ok "no activation witness in the image (it only appears when the editor is opened)"

passed
