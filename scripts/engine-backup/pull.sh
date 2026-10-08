#!/usr/bin/env bash
# Pull the engine VM's codespace backup onto the application VM (M6-05). Run
# as `srv` by its user timer quiz-engine-backup.timer, from the production
# checkout. The engine VM's key line runs backup-export.sh whatever is asked,
# so nothing is sent. Setup, checks and the restore:
# docs/development/deployment.md §3, Backup and restore of the codespace data.
#
# Any failure exits non-zero: the unit fails, and says why in srv's journal
# (journalctl --user -u quiz-engine-backup).
set -euo pipefail

DEST=/srv/quiz-engine-backups
KEEP=14
HOST=root@code.chevallier.io
KEY="$HOME/.ssh/engine-backup"

install -d -m 0700 "$DEST"
part="$DEST/.codespace.tar.zst.part"
trap 'rm -f "$part"' EXIT

ssh -T -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30 \
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
