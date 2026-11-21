#!/usr/bin/env bash
# The restore drill (docs/development/deployment.md §6): proves that a dump
# of production restores whole, without touching production's database.
#
#   cd /srv/quiz && scripts/restore-drill.sh        # as srv, on the application VM
#
# It fingerprints the running database (scripts/db-fingerprint.sql), dumps it,
# fingerprints it again, restores the dump into a throwaway PostgreSQL
# container (384 MB at most, removed on exit, with the dump), fingerprints
# the restore, and compares. A table that moved while the dump ran (its line
# differs before and after) proves nothing and is listed; every other line
# must be in the restore. Exit 0 when it is, 1 otherwise.
set -euo pipefail
export LC_ALL=C
cd "$(dirname "$(readlink -f "$0")")/.."

if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
C=(docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image)
drill=quiz-restore-drill
work=$(mktemp -d /tmp/restore-drill.XXXXXX)
chmod 700 "$work"
cleanup() {
  docker rm -f "$drill" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fingerprint() { "${C[@]}" exec -T postgres psql -XAq -F' | ' -v ON_ERROR_STOP=1 -U quiz -d quiz < scripts/db-fingerprint.sql; }

fingerprint > "$work/before.txt"
start=$(date +%s)
"${C[@]}" exec -T postgres pg_dump -Fc -U quiz -d quiz < /dev/null > "$work/drill.dump"
echo "drill: dump of $(stat -c %s "$work/drill.dump") bytes in $(($(date +%s) - start)) s"
fingerprint > "$work/after.txt"

docker run -d --rm --name "$drill" --memory 384m \
  -e POSTGRES_USER=quiz -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=quiz \
  postgres:17 -c shared_buffers=16MB -c max_connections=10 < /dev/null > /dev/null
# The image's entrypoint runs a temporary server, then the real one: the
# second "ready" line is the real one.
for _ in $(seq 120); do
  [ "$(docker logs "$drill" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] && break
  sleep 1
done
start=$(date +%s)
docker exec -i "$drill" pg_restore -U quiz -d quiz --no-owner --role=quiz --exit-on-error < "$work/drill.dump"
echo "drill: restored in $(($(date +%s) - start)) s"
docker exec -i "$drill" psql -XAq -F' | ' -v ON_ERROR_STOP=1 -U quiz -d quiz < scripts/db-fingerprint.sql > "$work/restored.txt"

sort "$work/before.txt" > "$work/before.sorted"
sort "$work/after.txt" > "$work/after.sorted"
sort "$work/restored.txt" > "$work/restored.sorted"
comm -12 "$work/before.sorted" "$work/after.sorted" > "$work/stable.sorted"
echo "drill: $(wc -l < "$work/stable.sorted") of $(wc -l < "$work/after.sorted") lines stable during the dump"
moved=$(comm -13 "$work/before.sorted" "$work/after.sorted" | cut -d'|' -f1)
[ -z "$moved" ] || printf 'drill: moved during the dump, not compared: %s\n' $moved
missing=$(comm -23 "$work/stable.sorted" "$work/restored.sorted")
if [ -n "$missing" ]; then
  echo "drill: FAILED, these lines are not in the restore:" >&2
  printf '%s\n' "$missing" >&2
  exit 1
fi
echo "drill: OK, every stable line is in the restore"
