#!/bin/sh
# Entrypoint of quiz-base, the workspace image (a file of its contract:
# contract/check holds every image derived from it to this copy).
# The root is read-only; the user-data-dir lives on the /run tmpfs.
set -eu

UDD=/run/code-server
SETTINGS=/etc/code-server/settings.json

mkdir -p "$UDD/User" "$UDD/Machine" "$UDD/logs"
cp "$SETTINGS" "$UDD/User/settings.json"
cp "$SETTINGS" "$UDD/Machine/settings.json"

# code-server writes a default config.yaml into $XDG_CONFIG_HOME;
# /home/student is read-only, so we send it to the /run tmpfs.
# Deliberately local to this script: the student's shell keeps the default
# values, so their --install-extension does aim at a read-only extensions
# directory.
XDG_CONFIG_HOME="$UDD/xdg-config"
export XDG_CONFIG_HOME
mkdir -p "$XDG_CONFIG_HOME/clangd"
# clangd inherits this XDG_CONFIG_HOME: without this copy it would read no
# configuration and fall back on its defaults.
cp /etc/clangd/config.yaml "$XDG_CONFIG_HOME/clangd/config.yaml"

# Extension gallery neutralised: no online installation is possible.
# shellcheck disable=SC2089  # the JSON is the value, quotes included
EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'
# shellcheck disable=SC2090
export EXTENSIONS_GALLERY

[ -d /work ] || mkdir -p /work

# The "Close" button of heig.codespace-statusbar opens CODESPACE_RETURN_URL
# (the platform, set by the portal from PLATFORM_URL) through
# vscode.env.openExternal, which asks "Do you want code-server to open the
# external website?" for any origin not trusted. Trust that origin; nothing
# when the variable is absent or not http(s).
# The portal's rootUrl() (src/sessions/manager.ts) guarantees an origin plus
# "/"; the value stays one quoted argv element, never read as a flag.
set --
case "${CODESPACE_RETURN_URL:-}" in
  http://* | https://*) set -- --link-protection-trusted-domains "${CODESPACE_RETURN_URL%/}" ;;
esac

# --disable-proxy: no port proxy on the origin every session shares (portal
# invariant 14, audit L24); held by contract/check.
exec code-server \
  --auth none \
  --disable-proxy \
  --bind-addr 0.0.0.0:8080 \
  --disable-file-downloads \
  --disable-file-uploads \
  --disable-workspace-trust \
  --disable-update-check \
  --disable-getting-started-override \
  --extensions-dir /opt/code-server/extensions \
  --user-data-dir /run/code-server \
  "$@" \
  /work
