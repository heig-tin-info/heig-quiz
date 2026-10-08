#!/usr/bin/env bash
#
# The engine VM's backup export (M6-05; ADR-016, M6-05 amendment): the SQLite
# and the volumes of every portal instance, as ONE zstd-compressed tar on
# stdout, which the application VM pulls once a day
# (scripts/engine-backup/pull.sh). Installed by cs_install_host as
# /usr/local/lib/quiz-codespace/backup-export.sh; root's authorized_keys pins
# the pulling key to it (deployment.md §3, Backup):
#   command="/usr/local/lib/quiz-codespace/backup-export.sh",restrict,from="128.140.71.35,2a01:4f8:1c19:1164::1" ssh-ed25519 AAAA… quiz-engine-backup@portal
# The client's command line is ignored: there is nothing to parse.
#
# The archive, for each instance <i> under /srv/quiz-codespace:
#   <i>/var-backup/codespace.sqlite    an online `.backup`, integrity-checked
#   <i>/volumes/<assignment>/<user>/{work,staging.git,shadow.git}
# with numeric owners and extended attributes: the volumes belong to the uid
# ranges --userns=auto drew. Never in it: /etc/quiz-codespace (the env files
# and their secrets), the live SQLite file and its -wal, the images.
#
# The volumes are read live. A file that changes during the read is taken as
# it is (tar's exit 1 is accepted, its exit 2 is not): the restore's
# `git fsck` says whether a repository came back whole, and shadow.git holds
# the work tree of three minutes earlier.
#
# Root, because only root reads every mapped uid's files. In codespace.slice
# at idle IO priority: it competes with the sessions, never with grading.
# Needs sqlite3 and zstd (apt install sqlite3 zstd).
set -euo pipefail

# Overridable for a test only; sshd passes the client no environment.
ROOT="${CODESPACE_DATA_ROOT:-/srv/quiz-codespace}"

if [ -z "${QUIZ_BACKUP_SCOPED:-}" ]; then
	export QUIZ_BACKUP_SCOPED=1
	exec systemd-run --quiet --scope --collect --slice=codespace.slice \
		nice -n 10 ionice -c 3 "$(readlink -f "$0")"
fi

for tool in sqlite3 zstd; do
	command -v "$tool" >/dev/null 2>&1 || { echo "backup-export: $tool is missing (apt install $tool)" >&2; exit 1; }
done

# On /srv itself: the copy never crosses a filesystem, and a dot name keeps it
# out of the instance glob below.
stage="$(mktemp -d "$ROOT/.backup-export.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

members=()
instances=0
shopt -s nullglob
for dir in "$ROOT"/*/; do
	i="$(basename "$dir")"
	# The portal's own instance charset (INSTANCE_PATTERN): nothing else is ours.
	[[ "$i" =~ ^[a-z][a-z0-9]{0,15}$ ]] || continue
	db="${dir}var/codespace.sqlite"
	if [ -f "$db" ]; then
		install -d -m 0700 "$stage/$i/var-backup"
		copy="$stage/$i/var-backup/codespace.sqlite"
		# `.backup` is SQLite's online copy: consistent while the portal writes.
		sqlite3 -cmd '.timeout 30000' "$db" ".backup '$copy'"
		check="$(sqlite3 "$copy" 'PRAGMA integrity_check')"
		if [ "$check" != ok ]; then
			echo "backup-export: $i: integrity_check of the copy: $check" >&2
			exit 1
		fi
		members+=(-C "$stage" "$i/var-backup")
	fi
	if [ -d "${dir}volumes" ]; then
		members+=(-C "$ROOT" "$i/volumes")
	fi
	instances=$((instances + 1))
done
if [ "${#members[@]}" -eq 0 ]; then
	echo "backup-export: nothing to export under $ROOT" >&2
	exit 1
fi

set +e
tar --numeric-owner --xattrs --xattrs-include='*' \
	--warning=no-file-changed --warning=no-file-removed \
	-cpf - "${members[@]}" | zstd -q -3 -T1 -c
status=("${PIPESTATUS[@]}")
set -e
if [ "${status[0]}" -gt 1 ] || [ "${status[1]}" -ne 0 ]; then
	echo "backup-export: tar exited ${status[0]}, zstd ${status[1]}" >&2
	exit 1
fi
echo "backup-export: $instances instance(s) exported" >&2
