#!/usr/bin/env bash
# Push the application VM's backups to the off-site borg repository on the
# Hetzner Storage Box (#235). Run as `srv` by its user unit
# quiz-offsite-backup.service, from the production checkout, with the path of
# the report to write as its argument. The repository and its credentials
# are in ~/.config/borg-offsite/env, outside the repository. The box forces
# this VM's key into `borg serve --append-only`: it can add archives, never
# remove one. Setup, checks, restore and prune (from the operator's
# workstation only, prune.sh): docs/development/deployment.md §6, The
# off-site copy.
#
# A borg error (exit 2 and above), a missing env file or a missing quiz
# dump directory fails the run and the unit, with the reason in srv's journal
# (journalctl --user -u quiz-offsite-backup); a borg warning (exit 1, a file
# that changed while read) is logged and counts as a copy. Either way one
# line of JSON goes to the report the app reads (ADR-055, the `offsite`
# check), through a temporary file and a rename.
set -uo pipefail

REPORT=${1:?usage: push.sh <report.json>}
ENV="$HOME/.config/borg-offsite/env"

# quiz's own dumps must be there; the other services of this VM are skipped
# when absent. Not here: the PostgreSQL data directories (the dumps suffice,
# the Hetzner VM backup holds the physical copy), the images (rebuilt or
# pulled) and the secrets (the vault, ADR-010).
REQUIRED=/srv/quiz/backups
OPTIONAL=(
  /srv/quiz/assets
  /srv/heig-classroom/backups
  /srv/evaluation-tb/backups
  /srv/evaluation-tb/assets
  /srv/quiz-engine-backups
)

rc=0
if [[ -r $ENV ]]; then
  # shellcheck source=/dev/null
  source "$ENV"
else
  echo "offsite-backup: $ENV is missing (BORG_REPO, BORG_REMOTE_PATH, BORG_PASSCOMMAND)" >&2
  rc=2
fi
export BORG_RSH="${BORG_RSH:-ssh -i $HOME/.ssh/storagebox-borg -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=30}"

if [[ ! -d $REQUIRED ]]; then
  echo "offsite-backup: $REQUIRED is missing" >&2
  rc=2
fi
paths=()
for dir in "${OPTIONAL[@]}"; do
  if [[ -d $dir ]]; then paths+=("$dir"); else echo "offsite-backup: $dir is missing, skipped"; fi
done

archive="$(hostname)-$(date +%Y-%m-%dT%H:%M)"
if ((rc == 0)); then
  # A dump or a pull still being written is a hidden or temporary file.
  borg create --compression zstd,6 --stats --show-rc --lock-wait 600 \
    --exclude 'sh:**/*.tmp' --exclude 'sh:**/.*.part' \
    "::$archive" "$REQUIRED" "${paths[@]}"
  rc=$?
fi
((rc == 1)) && echo "offsite-backup: borg warned (exit 1), the archive $archive is kept"

ok=$( ((rc < 2)) && echo true || echo false)
umask 022
if ! { printf '{"finished_at":"%s","ok":%s,"exit_code":%d,"file":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$rc" "$archive" > "$REPORT.tmp" && mv -f "$REPORT.tmp" "$REPORT"; }; then
  echo "offsite-backup: cannot write $REPORT" >&2
  exit 2
fi

((rc < 2)) || exit "$rc"
