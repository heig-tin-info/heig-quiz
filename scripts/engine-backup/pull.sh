#!/usr/bin/env bash
# Pull the engine VM's codespace backup onto the application VM (M6-05;
# ADR-016, M6-05 amendment: destination A, a stopgap while the online
# workspace is test-only). Run as `srv` by its user timer
# quiz-engine-backup.timer, from the production checkout:
#
#   /srv/quiz/scripts/engine-backup/pull.sh
#
# The engine VM's root key line runs apps/codespace/deploy/backup-export.sh
# whatever is asked, so this script sends no command: it streams the archive
# into a temporary name, checks that zstd can read it to the end, renames it
# codespace-<UTC date>.tar.zst and keeps the newest KEEP. Any failure exits
# non-zero: the unit fails and says why in srv's journal
# (journalctl --user -u quiz-engine-backup).
set -euo pipefail

DEST="${QUIZ_ENGINE_BACKUP_DIR:-/srv/quiz-engine-backups}"
KEEP="${QUIZ_ENGINE_BACKUP_KEEP:-14}"
HOST="${QUIZ_ENGINE_BACKUP_HOST:-root@code.chevallier.io}"
KEY="${QUIZ_ENGINE_BACKUP_KEY:-$HOME/.ssh/engine-backup}"

install -d -m 0700 "$DEST"
part="$DEST/.codespace.tar.zst.part"
trap 'rm -f "$part"' EXIT

ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30 \
  -o ServerAliveInterval=30 "$HOST" > "$part"
# A truncated stream (a dropped connection, a full disk) fails here.
zstd -q -t "$part"

file="$DEST/codespace-$(date -u +%F).tar.zst"
chmod 600 "$part"
mv -f "$part" "$file"
echo "engine-backup: $(du -h "$file" | cut -f1) in $file"

# Dated names sort chronologically; a second run on one day replaces its file.
mapfile -t old < <(find "$DEST" -maxdepth 1 -name 'codespace-*.tar.zst' -printf '%f\n' | sort -r | tail -n "+$((KEEP + 1))")
for name in "${old[@]}"; do
  rm -f "$DEST/$name"
  echo "engine-backup: removed $name (keeping $KEEP)"
done
echo "engine-backup: $(df -h --output=avail "$DEST" | tail -n 1 | tr -d ' ') left on $DEST"
