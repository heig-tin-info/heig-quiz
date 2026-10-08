#!/usr/bin/env bash
# The curl matrix of the classroom.chevallier.io fragments (merge task M8-03,
# docs/merge/06 §6.6): asserts the status and the `Location` of every pattern
# of classroom-redirect.caddy, or with --maintenance the 503 and `Retry-After`
# of classroom-maintenance.caddy. Prints every row, then exits nonzero if
# any row mismatched.
#
#   infra/caddy/check-classroom-redirects.sh https://classroom.chevallier.io
#   infra/caddy/check-classroom-redirects.sh --maintenance https://classroom.chevallier.io
#   # the production name against one address, before the DNS points there:
#   infra/caddy/check-classroom-redirects.sh --resolve classroom.chevallier.io:443:128.140.71.35 https://classroom.chevallier.io
#   # a local Caddy on a high port:
#   CLASSROOM_SITE=http://:18480 caddy run --adapter caddyfile --config infra/caddy/classroom-redirect.caddy
#   infra/caddy/check-classroom-redirects.sh http://127.0.0.1:18480
set -euo pipefail

usage() { echo "usage: $0 [--maintenance] [--resolve HOST:PORT:ADDR] BASE_URL" >&2; exit 2; }

mode=redirect
curl_extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --maintenance) mode=maintenance; shift ;;
    --resolve) [[ $# -ge 2 ]] || usage; curl_extra+=(--resolve "$2"); shift 2 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) break ;;
  esac
done
[[ $# -eq 1 ]] || usage
base="${1%/}"

quiz=https://quiz.chevallier.io
legacy="$quiz/legacy/classroom"
cid=0b6f6c1e-3c1a-4c2e-9d6a-1f2e3d4c5b6a
aid=7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d
uid=3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f
failures=0

# check METHOD PATH STATUS EXPECTED_HEADER_VALUE [HEADER]
# HEADER defaults to `location`; an empty expected value asserts its absence.
check() {
  local method=$1 path=$2 want_status=$3 want_value=$4 header=${5:-location}
  local out got_status got_value
  out=$(curl -sS -o /dev/null -X "$method" ${curl_extra[@]+"${curl_extra[@]}"} \
    -w "%{http_code}\n%header{$header}" "$base$path") || { echo "FAIL $method $path: curl error"; failures=$((failures + 1)); return; }
  got_status=$(sed -n 1p <<<"$out")
  got_value=$(sed -n 2p <<<"$out")
  if [[ "$got_status" == "$want_status" && "$got_value" == "$want_value" ]]; then
    echo "ok   $method $path -> $got_status ${got_value}"
  else
    echo "FAIL $method $path -> $got_status $header=[$got_value], want $want_status $header=[$want_value]"
    failures=$((failures + 1))
  fi
}

if [[ $mode == maintenance ]]; then
  for path in / /classrooms/$cid "/app/auth/github/callback?code=x" /app/api/me /healthz; do
    check GET "$path" 503 3600 retry-after
  done
  check POST /webhooks/github 503 3600 retry-after
  check GET / 503 "text/html; charset=utf-8" content-type
  check POST /webhooks/github 503 application/json content-type
else
  # Dead machine paths: 410 JSON, never a redirect.
  for path in /webhooks/github /app/api/me /app/api/classrooms/$cid \
    /app/api/journals/$cid/assets/img/fig.png /app/api/users/$uid /app/events \
    /kc/realms/heig/protocol/openid-connect/auth /healthz /metrics; do
    check GET "$path" 410 ""
  done
  check POST /webhooks/github 410 ""
  check POST /webhooks/github 410 application/json content-type

  # Through the resolver (M8-02), the query kept.
  for path in /classrooms/$cid /classrooms/$cid/ /classrooms/$cid/assignments/$aid \
    /classrooms/$cid/assignments/$aid/groups /classrooms/$cid/journal \
    /classrooms/$cid/journal/week-01/lab.md "/classrooms/$cid?tab=journal" \
    /classrooms/not-a-uuid /app/codespace/start/$aid /app/api/users/$uid/avatar; do
    check GET "$path" 302 "$legacy$path"
  done

  # Fixed rows: the query dropped.
  check GET "/app/auth/github/callback?code=c0de&state=s7" 302 "$quiz/settings"
  check GET "/app/email/unsub?t=t0ken" 302 "$quiz/settings"
  check GET /settings 302 "$quiz/settings"
  check GET /admin 302 "$quiz/admin"
  check GET /admin/users 302 "$quiz/admin"
  for path in / "/setup/github/installed?installation_id=1&setup_action=install" \
    /app/auth/login "/app/auth/callback?code=c0de" /classrooms /assignments/$aid /unknown; do
    check GET "$path" 302 "$quiz/"
  done
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures mismatch(es)" >&2
  exit 1
fi
echo "all $mode checks passed"
