#!/usr/bin/env bash
# Prune and compact the off-site borg repository (#235). Run BY HAND from the
# operator's workstation, never from the VM: it needs the box's full-access
# key (the VM's key is append-only, and its deletions are not real until a
# compact). The repository and the credentials are in
# ~/.config/borg-offsite/env. Setup and the recovery it points to:
# docs/development/deployment.md §6, The off-site copy.
#
# Before touching anything it refuses, so that a compact never makes a
# deletion through the append-only key permanent, when
#   - an archive of the list it saved at its previous run is gone, or
#   - a calendar day after the newest archive of that list, up to yesterday,
#     has no archive (`<host>-YYYY-MM-DDT…`): an archive made since and
#     deleted. --accept-gaps overrides it once the gap is explained (a VM
#     outage);
#   - there is no saved list: --first-run, after reading the repository's
#     `transactions` file.
# It cannot see a deleted archive of a day that still has another one, nor
# today's.
set -euo pipefail

usage="usage: prune.sh [--first-run] [--accept-gaps]"
ENV="$HOME/.config/borg-offsite/env"
STATE="$HOME/.config/borg-offsite/last-archives"
first_run=false accept_gaps=false
for arg; do
  case $arg in
    --first-run) first_run=true ;;
    --accept-gaps) accept_gaps=true ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[[ -r $ENV ]] || { echo "prune: $ENV is missing (BORG_REPO, BORG_REMOTE_PATH, BORG_PASSCOMMAND, BORG_RSH)" >&2; exit 2; }
# shellcheck source=/dev/null
source "$ENV"

refuse() {
  printf 'prune: %s\n' "$@" >&2
  echo "prune: nothing pruned nor compacted; read the repository's transactions file first (deployment.md §6)." >&2
  exit 1
}

now=$(borg list --short | sort)
if [[ ! -s $STATE ]]; then
  $first_run || refuse "no saved list in $STATE: run with --first-run once the repository is checked"
else
  gone=$(comm -23 "$STATE" <(printf '%s\n' "$now"))
  [[ -z $gone ]] || refuse "archives gone since the last prune, not by it:" "$gone"
  day=$(tail -n 1 "$STATE" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -n 1) || refuse "no date in the newest saved archive"
  yesterday=$(date -d yesterday +%F)
  missing=()
  while day=$(date -d "$day +1 day" +%F) && [[ ! $day > $yesterday ]]; do
    grep -q -- "-${day}T" <<< "$now" || missing+=("$day")
  done
  ((${#missing[@]} == 0)) || $accept_gaps || refuse "no archive on ${missing[*]}: check (a VM outage?), then --accept-gaps"
fi

# One host writes this repository; a second one would need --glob-archives.
borg prune --list --keep-daily 7 --keep-weekly 8 --keep-monthly 12
borg compact
install -d -m 0700 "$(dirname "$STATE")"
borg list --short | sort > "$STATE"
echo "prune: $(wc -l < "$STATE") archives kept"
