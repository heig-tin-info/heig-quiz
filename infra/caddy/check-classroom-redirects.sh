#!/usr/bin/env bash
# The curl matrix of the classroom.chevallier.io fragments (merge task M8-03,
# docs/merge/06 §6.6): asserts the status and headers of every pattern of
# classroom-redirect.caddy, or with --maintenance those of
# classroom-maintenance.caddy. Prints every row, then exits nonzero if any
# row mismatched. Needs curl >= 7.84 (`%header{}`).
#
#   infra/caddy/check-classroom-redirects.sh https://classroom.chevallier.io
#   infra/caddy/check-classroom-redirects.sh --maintenance https://classroom.chevallier.io
#   # the production name against one address, before the DNS points there:
#   infra/caddy/check-classroom-redirects.sh --resolve classroom.chevallier.io:443:128.140.71.35 https://classroom.chevallier.io
#   # a local Caddy on a high port:
#   CLASSROOM_SITE=http://:18480 caddy run --adapter caddyfile --config infra/caddy/classroom-redirect.caddy
#   infra/caddy/check-classroom-redirects.sh http://127.0.0.1:18480
set -euo pipefail

usage() { echo "usage: $0 [--maintenance] [--resolve HOST:PORT:ADDR] BASE_URL  (curl >= 7.84)" >&2; exit 2; }

mode=redirect
curl_extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --maintenance) mode=maintenance; shift ;;
    --resolve) [[ $# -ge 2 ]] || usage; curl_extra+=(--resolve "$2"); shift 2 ;;
    -*) usage ;;
    *) break ;;
  esac
done
[[ $# -eq 1 ]] || usage
base="${1%/}"

legacy=https://quiz.chevallier.io/legacy/classroom
cid=0b6f6c1e-3c1a-4c2e-9d6a-1f2e3d4c5b6a
aid=7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d
uid=3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f
failures=0

# check METHOD PATH STATUS [HEADER=VALUE ...]: one request, the status and
# each named header asserted (an empty VALUE asserts the header is absent).
check() {
  local method=$1 path=$2 want=$3; shift 3
  local fmt="%{http_code}" h out got
  for h in "$@"; do fmt+="\n%header{${h%%=*}}"; done
  out=$(curl -sS -o /dev/null -X "$method" ${curl_extra[@]+"${curl_extra[@]}"} -w "$fmt" "$base$path") \
    || { echo "FAIL $method $path: curl error"; failures=$((failures + 1)); return; }
  local -a lines
  mapfile -t lines <<<"$out"
  got="${lines[0]}"
  local ok=1 i=1 report="$got"
  [[ "$got" == "$want" ]] || ok=0
  for h in "$@"; do
    [[ "${lines[$i]:-}" == "${h#*=}" ]] || ok=0
    report+=" ${h%%=*}=[${lines[$i]:-}]"
    i=$((i + 1))
  done
  if [[ $ok == 1 ]]; then
    echo "ok   $method $path -> $report"
  else
    echo "FAIL $method $path -> $report, want $want $*"
    failures=$((failures + 1))
  fi
}

if [[ $mode == maintenance ]]; then
  for path in / /classrooms/$cid "/app/auth/github/callback?code=x" /app/api/me /healthz; do
    check GET "$path" 503 "retry-after=3600" "cache-control=no-store" "content-type=text/html; charset=utf-8"
  done
  check POST /webhooks/github 503 "retry-after=3600" "cache-control=no-store" "content-type=application/json"
else
  # Dead machine paths: 410 JSON, never a redirect.
  for path in /webhooks/github /app/api/me /app/api/classrooms/$cid \
    /app/api/journals/$cid/assets/img/fig.png /app/api/users/$uid /app/events \
    /kc/realms/heig/protocol/openid-connect/auth /healthz /metrics; do
    check GET "$path" 410 "location=" "content-type=application/json"
  done
  check POST /webhooks/github 410 "location=" "content-type=application/json"

  # Everything else: to the resolver, the path as sent, percent-encoding kept.
  for path in / /classrooms/$cid /classrooms/$cid/assignments/$aid \
    /classrooms/$cid/assignments/$aid/groups /classrooms/$cid/journal \
    /classrooms/$cid/journal/week-01/lab.md "/classrooms/$cid/journal/a%20b%2Fc%3Fd.md" \
    /app/codespace/start/$aid /app/api/users/$uid/avatar \
    /app/auth/github/callback /app/auth/login /app/email/unsub /setup/github/installed \
    /settings /admin /admin/users /classrooms /unknown; do
    check GET "$path" 302 "location=$legacy$path"
  done

  # The query never reaches Quiz.
  check GET "/app/auth/github/callback?code=c0de&state=s7" 302 "location=$legacy/app/auth/github/callback"
  check GET "/app/email/unsub?t=t0ken" 302 "location=$legacy/app/email/unsub"
  check GET "/classrooms/$cid?tab=journal" 302 "location=$legacy/classrooms/$cid"
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures mismatch(es)" >&2
  exit 1
fi
echo "all $mode checks passed"
