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
# The code section below runs only against a real runner. `disabled` is the
# ordinary answer of a machine with no container engine (decision D14) and
# `down` is one that is configured but unreachable: neither is a failure of
# this walk, and neither stops it.
RUNNER="$(jq -r '.checks.runner // "disabled"' <"$BODY")"
printf '   .. runner is %s\n' "$RUNNER"

step "teacher session"
login "$TEACHER" teacher
api "$TEACHER" GET /app/api/courses; expect 200 "GET /courses"
COURSE_ID="$(jqx '.[0].id' 'first course')"
api "$TEACHER" GET "/app/api/courses/$COURSE_ID"; expect 200 "GET /courses/:id"
CLASSROOM_ID="$(jqx '.classrooms[0].id' 'first classroom')"
POOL_ID="$(jqx '.pools[0].id' 'first pool of the course')"
api "$TEACHER" GET /app/api/pools; expect 200 "GET /pools"
api "$TEACHER" GET "/app/api/pools/$POOL_ID/questions?limit=100"; expect 200 "GET /pools/:id/questions"
# Not a code question: the evaluation below gets exactly ONE code item, the
# one whose region the walk writes (`$CODE_Q`), so a pool that happens to list
# a code question first cannot make the walk edit the wrong program.
EXISTING_Q="$(jqx '[.items[] | select(.type != "code")][0].id' 'an existing question')"
# The seeded C exercise, by name: the two answers below are written for THAT
# question (a `somme` over an array), so any other code question would only
# produce a confusing link error.
CODE_Q="$(jq -r '[.items[] | select(.internalName=="prg1-code-somme-tableau")][0].id // empty' <"$BODY")"
printf '   .. %s questions in the pool\n' "$(jq -r '.items | length' <"$BODY")"

# --- the code runner, only when there is one -------------------------------
# The seeded C question carries visible AND hidden cases, so one `try` with the
# reference solution and one with a wrong answer exercise the whole path:
# assemble server-side, compile in a container, run every case, compare.
if [ "$RUNNER" = "up" ] && [ -n "$CODE_Q" ]; then
  step "code runner: the teacher rehearses a C question"
  RIGHT='"\nint somme(const int *t, int n) {\n    int total = 0;\n    for (int i = 0; i < n; i++) {\n        total += t[i];\n    }\n    return total;\n}\n"'
  WRONG='"\nint somme(const int *t, int n) {\n    int total = 0;\n    for (int i = 0; i <= n; i++) {\n        total += t[i];\n    }\n    return total;\n}\n"'

  api "$TEACHER" POST "/app/api/questions/$CODE_Q/try" "{\"source\":1,\"answer\":{\"regions\":[$RIGHT]}}"
  expect 200 "POST /questions/:id/try (reference solution)"
  [ "$(jq -r .status <"$BODY")" = "graded" ] \
    || fail "try: the runner did not answer ($(jq -r '.status, .reason' <"$BODY" | tr '\n' ' '))"
  jq -e '.details.compile.ok == true' <"$BODY" >/dev/null || fail "try: the reference solution did not compile"
  jq -e '.points == .maxPoints and .points > 0' <"$BODY" >/dev/null \
    || fail "try: the reference solution scored $(jq -r .points <"$BODY") / $(jq -r .maxPoints <"$BODY")"
  jq -e '[.details.cases[] | select(.ok == false)] | length == 0' <"$BODY" >/dev/null \
    || fail "try: a case failed on the reference solution"
  printf '   ok  %s / %s points, %s cases, compiled in %s ms\n' \
    "$(jq -r .points <"$BODY")" "$(jq -r .maxPoints <"$BODY")" \
    "$(jq -r '.details.cases | length' <"$BODY")" "$(jq -r .details.compile.ms <"$BODY")"

  api "$TEACHER" POST "/app/api/questions/$CODE_Q/try" "{\"source\":1,\"answer\":{\"regions\":[$WRONG]}}"
  expect 200 "POST /questions/:id/try (off-by-one answer)"
  jq -e '.points < .maxPoints' <"$BODY" >/dev/null || fail "try: the wrong answer scored full marks"
  # A failing case must carry what the program actually printed: without the
  # `got`, a student is told they are wrong and nothing else.
  jq -e '[.details.cases[] | select(.ok == false and (.actual // "") != "")] | length > 0' <"$BODY" >/dev/null \
    || fail "try: the failing case carries no output"
  printf '   ok  %s / %s points; first failure expected %s got %s\n' \
    "$(jq -r .points <"$BODY")" "$(jq -r .maxPoints <"$BODY")" \
    "$(jq -r '[.details.cases[] | select(.ok == false)][0].expected' <"$BODY" | head -c 40)" \
    "$(jq -r '[.details.cases[] | select(.ok == false)][0].actual' <"$BODY" | head -c 40)"
fi

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
# The code question joins the evaluation only when a runner can answer for it.
if [ "$RUNNER" = "up" ] && [ -n "$CODE_Q" ]; then
  ITEMS="[\"$QUESTION_ID\",\"$EXISTING_Q\",\"$CODE_Q\"]"; WANT=3
else
  ITEMS="[\"$QUESTION_ID\",\"$EXISTING_Q\"]"; WANT=2
fi
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/items" "{\"questionIds\":$ITEMS}"
expect 200 "POST /evaluations/:id/items"
[ "$(jq -r 'length' <"$BODY")" = "$WANT" ] || fail "items: expected $WANT items"
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
CODE_ITEM="$(jq -r '[.view.items[] | select(.type=="code")][0].id // empty' <"$BODY")"
for rev in 1 2; do
  api "$STUDENT" PUT "/app/api/attempts/$ATTEMPT_ID/answers/$ITEM_ID" \
    "{\"payload\":{\"text\":\"$((2 + rev))\"},\"revision\":$rev,\"clientTs\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
  expect 200 "PUT answer (revision $rev)"
  [ "$(jq -r .accepted <"$BODY")" = "true" ] || fail "autosave: revision $rev was refused"
done
# The Run button: the visible cases only, and never the hidden half.
if [ "$RUNNER" = "up" ] && [ -n "$CODE_ITEM" ]; then
  api "$STUDENT" POST "/app/api/attempts/$ATTEMPT_ID/run" \
    "{\"itemId\":\"$CODE_ITEM\",\"regions\":[$RIGHT]}"
  expect 202 "POST /attempts/:id/run"
  jq -e '.result.status == "ok" and .result.compile.ok == true' <"$BODY" >/dev/null \
    || fail "run: the runner did not compile the student's code"
  jq -e '[.result.cases[] | select(.ok == false)] | length == 0' <"$BODY" >/dev/null \
    || fail "run: a visible case failed on the reference solution"
  printf '   ok  %s visible cases, first one in %s ms\n' \
    "$(jq -r '.result.cases | length' <"$BODY")" "$(jq -r '.result.cases[0].ms' <"$BODY")"
fi

api "$STUDENT" POST "/app/api/attempts/$ATTEMPT_ID/submit" '{"confirm":true}'
expect 200 "POST /attempts/:id/submit"

step "close, grade, release"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/close" '{}'
expect 200 "POST /evaluations/:id/close"
api "$TEACHER" POST "/app/api/evaluations/$EVAL_ID/grading/run" '{}'
expect 202 "POST /evaluations/:id/grading/run"
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
