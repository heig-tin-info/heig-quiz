#!/usr/bin/env bash
#
# End-to-end HTTP smoke test (`pnpm smoke`). One whole life of an evaluation
# against a RUNNING api, over HTTP only: the teacher signs in, authors and
# publishes a question, builds and opens an evaluation; a student answers it
# and hands it in; the teacher closes, grades, releases and exports it; the
# student reads the feedback. Nothing is mocked, nothing is read from the
# database. Needs a seeded database, AUTH_DEV_LOGIN=1, curl and jq.
#
# Usage: scripts/smoke.sh [base-url]        (default http://localhost:3000)
set -euo pipefail

BASE="${1:-${SMOKE_BASE_URL:-http://localhost:3000}}"
JAR_DIR="$(mktemp -d)"
TEACHER="$JAR_DIR/teacher.jar"
STUDENT="$JAR_DIR/student.jar"
BODY="$JAR_DIR/body"
STAMP="$(date +%s)"
trap 'rm -rf "$JAR_DIR"' EXIT

step() { printf '\n== %s\n' "$1"; }
fail() {
  printf '\nFAILED: %s\n' "$1" >&2
  if [ -s "$BODY" ]; then head -c 600 "$BODY" >&2; printf '\n' >&2; fi
  exit 1
}

# api <jar> <method> <path> [json-body] -> body in $BODY, status in $STATUS
# Every mutation carries the double-submit CSRF token, exactly like the SPA:
# the cookie is readable, the header is what the server compares it against.
api() {
  local jar="$1" method="$2" path="$3" data="${4:-}" token=""
  local args=(-sS -o "$BODY" -w '%{http_code}' -b "$jar" -c "$jar" -X "$method" "$BASE$path")
  [ -f "$jar" ] && token="$(awk '$6 == "quiz_csrf" { print $7 }' "$jar" | tail -n1)"
  [ -n "$token" ] && args+=(-H "x-csrf-token: $token")
  [ -n "$data" ] && args+=(-H 'content-type: application/json' -d "$data")
  STATUS="$(curl "${args[@]}")"
}

# expect <status> <what>: the first failed expectation ends the run
expect() {
  [ "$STATUS" = "$1" ] || fail "$2: expected HTTP $1, got $STATUS"
  printf '   ok  %s\n' "$2"
}

# jqx <filter> <what> — read a value that must not be null/empty
jqx() {
  local value; value="$(jq -r "$1" <"$BODY")"
  [ -n "$value" ] && [ "$value" != "null" ] || fail "$2: no value at $1"
  printf '%s' "$value"
}

login() { # login <jar> <persona>
  STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' -c "$1" -b "$1" \
    -d "persona=$2" "$BASE/app/auth/dev")"
  [ "$STATUS" = "302" ] || fail "dev login as $2: expected 302, got $STATUS"
  printf '   ok  signed in as %s\n' "$2"
}

# The queue is in-process on the embedded database: the pass starts on the
# next tick, so the panel is only read once every cell has been settled.
wait_grading() {
  for _ in $(seq 40); do
    api "$TEACHER" GET "/app/api/evaluations/$1/grading/progress"
    [ "$STATUS" = "200" ] || fail "GET /grading/progress: HTTP $STATUS"
    if jq -e '.total > 0 and (.done + .pending.runner + .pending.llm + .failed) >= .total' \
        <"$BODY" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  fail "grading did not settle in 10 s"
}

step "health"
api "$TEACHER" GET /healthz; expect 200 "GET /healthz"
[ "$(jq -r .checks.database <"$BODY")" = "up" ] || fail "healthz: database is not up"

step "teacher session"
login "$TEACHER" teacher
api "$TEACHER" GET /app/api/courses; expect 200 "GET /courses"
COURSE_ID="$(jqx '.[0].id' 'first course')"
api "$TEACHER" GET "/app/api/courses/$COURSE_ID"; expect 200 "GET /courses/:id"
CLASSROOM_ID="$(jqx '.classrooms[0].id' 'first classroom')"
POOL_ID="$(jqx '.pools[0].id' 'first pool of the course')"
api "$TEACHER" GET /app/api/pools; expect 200 "GET /pools"
api "$TEACHER" GET "/app/api/pools/$POOL_ID/questions"; expect 200 "GET /pools/:id/questions"
EXISTING_Q="$(jqx '.items[0].id' 'an existing question')"
printf '   .. %s questions in the pool\n' "$(jq -r '.items | length' <"$BODY")"

step "author and publish a fresh question"
api "$TEACHER" POST "/app/api/pools/$POOL_ID/questions" \
  "{\"type\":\"short\",\"internalName\":\"smoke-$STAMP\"}"
expect 201 "POST /pools/:id/questions"
QUESTION_ID="$(jqx '.meta.id' 'new question id')"
CONFIG='{"configVersion":1,"prompt":"Combien d’octets occupe un `int` sur une machine 64 bits ?","kind":"number","matchers":[{"kind":"number","value":4,"tolerance":0}]}'
api "$TEACHER" PUT "/app/api/questions/$QUESTION_ID/draft" \
  "{\"config\":$CONFIG,\"explanation\":\"Quatre octets sur les ABI usuelles.\"}"
expect 200 "PUT /questions/:id/draft"
[ "$(jq -r .valid <"$BODY")" = "true" ] || fail "draft: the config was stored as invalid"
api "$TEACHER" POST "/app/api/questions/$QUESTION_ID/publish" '{"changeNote":"smoke"}'
expect 201 "POST /questions/:id/publish"
[ "$(jq -r .number <"$BODY")" = "1" ] || fail "publish: expected version 1"

step "build and open an evaluation"
api "$TEACHER" POST "/app/api/classrooms/$CLASSROOM_ID/evaluations" \
  "{\"title\":\"Smoke $STAMP\",\"mode\":\"exam\",\"preset\":\"exam\"}"
expect 201 "POST /classrooms/:id/evaluations"
EVAL_ID="$(jqx '.id' 'evaluation id')"
api "$TEACHER" PATCH "/app/api/evaluations/$EVAL_ID" '{"durationS":1800}'
expect 200 "PATCH /evaluations/:id (duration)"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/items" \
  "{\"questionIds\":[\"$QUESTION_ID\",\"$EXISTING_Q\"]}"
expect 200 "POST /evaluations/:id/items"
[ "$(jq -r 'length' <"$BODY")" = "2" ] || fail "items: expected two items"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/state" '{"to":"lobby"}'
expect 200 "POST /evaluations/:id/state (lobby)"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/start" '{"confirm":true}'
expect 200 "POST /evaluations/:id/start"

step "student attempt"
login "$STUDENT" lea
api "$STUDENT" POST "/app/api/evaluations/$EVAL_ID/attempt" '{}'
expect 200 "POST /evaluations/:id/attempt"
[ "$(jq -r .kind <"$BODY")" = "attempt" ] || fail "attempt: the student landed in the lobby"
ATTEMPT_ID="$(jqx '.view.attempt.id' 'attempt id')"
ITEM_ID="$(jqx '[.view.items[] | select(.type=="short")][0].id' 'a short item')"
for rev in 1 2; do
  api "$STUDENT" PUT "/app/api/attempts/$ATTEMPT_ID/answers/$ITEM_ID" \
    "{\"payload\":{\"text\":\"$((2 + rev))\"},\"revision\":$rev,\"clientTs\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
  expect 200 "PUT answer (revision $rev)"
  [ "$(jq -r .accepted <"$BODY")" = "true" ] || fail "autosave: revision $rev was refused"
done
api "$STUDENT" POST "/app/api/attempts/$ATTEMPT_ID/submit" '{"confirm":true}'
expect 200 "POST /attempts/:id/submit"

step "close, grade, release"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/close" '{}'
expect 200 "POST /evaluations/:id/close"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/grade" '{}'
expect 202 "POST /evaluations/:id/grade"
wait_grading "$EVAL_ID"
api "$TEACHER" GET "/app/api/evaluations/$EVAL_ID/grading"; expect 200 "GET /evaluations/:id/grading"
TOTAL="$(jqx '.counts.total' 'grading counts')"
[ "$TOTAL" -ge 2 ] || fail "panel: expected at least two graded cells, got $TOTAL"
printf '   .. %s cells, %s validated\n' "$TOTAL" "$(jq -r .counts.validated <"$BODY")"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/release" '{"confirm":true}'
expect 200 "POST /evaluations/:id/release"

step "CSV export"
STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' -b "$TEACHER" -c "$TEACHER" \
  "$BASE/app/api/evaluations/$EVAL_ID/results.csv")"
expect 200 "GET /evaluations/:id/results.csv"
[ "$(head -c 3 "$BODY" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] \
  || fail "CSV: the UTF-8 BOM is missing (Excel would mangle the accents)"
printf '   ok  UTF-8 BOM present, %s lines\n' "$(wc -l <"$BODY" | tr -d ' ')"

step "student feedback"
api "$STUDENT" GET "/app/api/attempts/$ATTEMPT_ID/feedback"; expect 200 "GET /attempts/:id/feedback"
[ "$(jq -r .available <"$BODY")" = "true" ] || fail "feedback: still unavailable after the release"
# The second revision was the right answer: a zero here would mean the
# grading pass never read what the student actually left behind.
jq -e '.points > 0' <"$BODY" >/dev/null || fail "feedback: the correct answer scored nothing"
printf '   ok  %s / %s points\n' "$(jq -r .points <"$BODY")" "$(jq -r .totalPoints <"$BODY")"

printf '\nsmoke: every expectation passed (%s)\n' "$BASE"
