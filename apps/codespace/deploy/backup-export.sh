#!/usr/bin/env bash
#
# The engine VM's backup export (M6-05): every portal instance's SQLite and
# volumes as one zstd tar on stdout, pulled daily by the application VM.
# root's forced command for the backup key; what it holds, the key line and
# the restore: docs/development/deployment.md §3, Backup and restore of the
# codespace data.
set -euo pipefail

ROOT=/srv/quiz-codespace

# Into codespace.slice, at idle IO priority: beside the sessions, never in
# grading's way. A forced command starts in the SSH session's scope.
if [ -z "${QUIZ_BACKUP_SCOPED:-}" ]; then
	export QUIZ_BACKUP_SCOPED=1
	exec systemd-run --quiet --scope --collect --slice=codespace.slice \
		nice -n 10 ionice -c 3 "$(readlink -f "$0")"
fi

for tool in sqlite3 zstd; do
	command -v "$tool" >/dev/null 2>&1 || { echo "backup-export: $tool is missing (apt install $tool)" >&2; exit 1; }
done

# On /srv itself; the dot name keeps it out of the instance glob.
stage="$(mktemp -d "$ROOT/.backup-export.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

members=()
instances=0
shopt -s nullglob
for dir in "$ROOT"/*/; do
	i="$(basename "$dir")"
	# The portal's instance charset (INSTANCE_PATTERN): nothing else is ours.
	[[ "$i" =~ ^[a-z][a-z0-9]{0,15}$ ]] || continue
	db="${dir}var/codespace.sqlite"
	if [ -f "$db" ]; then
		install -d -m 0700 "$stage/$i/var-backup"
		copy="$stage/$i/var-backup/codespace.sqlite"
		# SQLite's online copy: consistent while the portal writes.
		sqlite3 -cmd '.timeout 30000' "$db" ".backup '$copy'"
		# The cs_session bearer of every open session leaves nothing: an empty
		# token matches no cookie (checkCookie), so a restored session needs
		# a new launch. VACUUM drops the old values from the free pages.
		sqlite3 "$copy" "UPDATE sessions SET cookie_token = ''; VACUUM;"
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

# The volumes are read live: tar's exit 1 (a file changed while read) is
# accepted, its exit 2 is not.
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
