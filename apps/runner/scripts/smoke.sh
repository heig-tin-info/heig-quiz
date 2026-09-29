#!/usr/bin/env bash
#
# The runner's self-test against a LIVE service: one tiny program per language
# the runner advertises on `GET /health`, posted to `POST /run`, one line per
# language. Exits non-zero if /health does not answer, if it advertises no
# language, or if any language fails (#234).
#
#   RUNNER_TOKEN=… apps/runner/scripts/smoke.sh https://code.chevallier.io:8443
#   apps/runner/scripts/smoke.sh http://localhost:3200      # a dev runner, no token
#
# In production it runs from the APPLICATION VM, the only address the code
# VM's Caddy admits, with the token of /srv/quiz/.env.prod
# (docs/development/deployment.md §3). The token is read from the environment
# and handed to curl through a file descriptor: it never appears on a command
# line, in `ps`, or in this script's output.
#
# Each program reads 21 on stdin and prints 42 (spice: a 42 V source, its node
# voltage printed), so "ok" means the image is there, the toolchain builds and
# runs under the hardened container, and the output comes back. Needs curl and
# python3 (for the JSON), both on a stock Ubuntu.
set -euo pipefail
set +x # never trace: a trace would print the token

base="${1:-}"
if [ -z "$base" ]; then
  echo "usage: RUNNER_TOKEN=<token> $0 <base-url>" >&2
  exit 2
fi
base="${base%/}"
for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "smoke: $tool is required" >&2; exit 2; }
done
if [ -z "${RUNNER_TOKEN:-}" ]; then
  echo "smoke: RUNNER_TOKEN is empty: fine for a dev runner, a 401 anywhere else" >&2
fi

# The JSON half: what to send per language, and what its answer means.
read -r -d '' JSON_HELPER <<'PY' || true
import json, sys

PROGRAMS = {
    "c": ("main.c", '#include <stdio.h>\nint main(void){int n=0;if(scanf("%d",&n)!=1)n=0;printf("%d\\n",n*2);return 0;}\n'),
    "cpp": ("main.cpp", '#include <iostream>\nint main(){int n=0;std::cin>>n;std::cout<<n*2<<"\\n";return 0;}\n'),
    "python": ("main.py", "print(int(input()) * 2)\n"),
    "js": ("main.js", 'console.log(parseInt(require("node:fs").readFileSync(0, "utf8"), 10) * 2);\n'),
    "rust": ("main.rs", 'use std::io::Read;\nfn main(){let mut s=String::new();std::io::stdin().read_to_string(&mut s).unwrap();let n:i64=s.trim().parse().unwrap_or(0);println!("{}",n*2);}\n'),
    "spice": ("s0.cir", "* smoke\nV1 a 0 42\nR1 a 0 1k\n.op\n.control\nop\nprint v(a)\n.endc\n.end\n"),
}
# What the case's stdout must contain.
EXPECT = {"spice": "4.200000e+01"}

mode = sys.argv[1]
if mode == "languages":
    health = json.load(sys.stdin)
    print(" ".join(health.get("languages", [])))
elif mode == "request":
    lang = sys.argv[2]
    if lang not in PROGRAMS:
        sys.exit(3)
    name, source = PROGRAMS[lang]
    print(json.dumps({
        "language": lang,
        "files": [{"name": name, "content": source}],
        "compileArgs": "",
        "action": "run",
        # Generous: rustc alone takes a couple of seconds; the smoke test asks
        # whether a language works, not how fast.
        "limits": {"timeMs": 5000, "memoryMb": 256, "outputKb": 64},
        "cases": [{"name": "smoke", "args": [name] if lang == "spice" else [], "stdin": "21\n"}],
        "priority": "interactive",
    }))
elif mode == "verdict":
    lang, status, wall = sys.argv[2], sys.argv[3], sys.argv[4]
    raw = sys.stdin.read()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    def line(ok, what):
        print(f"{lang:<7} {'ok  ' if ok else 'FAIL'} {what}")
        sys.exit(0 if ok else 1)
    if status != "200" or not isinstance(body, dict) or "compile" not in body:
        error = body.get("error") if isinstance(body, dict) else (raw.strip()[:80] or "no answer")
        line(False, f"http {status}: {error}  ({wall} ms)")
    compile_ = body["compile"]
    if not compile_["ok"]:
        first = next((l for l in compile_["stderr"].splitlines() if l.strip()), "")
        line(False, f"compile error: {first[:100]}  ({wall} ms)")
    if not body["cases"]:
        line(False, f"no case ran  ({wall} ms)")
    case = body["cases"][0]
    timing = f"compile {round(compile_['ms'])} ms, run {round(case['ms'])} ms, total {wall} ms"
    if case["timedOut"]:
        line(False, f"killed: timed out  ({timing})")
    if case["oom"]:
        line(False, f"killed: out of memory  ({timing})")
    if case["exitCode"] != 0 or EXPECT.get(lang, "42") not in case["stdout"]:
        first = next((l for l in case["stderr"].splitlines() if l.strip()), "")
        line(False, f"exit {case['exitCode']}, stdout {case['stdout'][:40]!r} {first[:80]}  ({timing})")
    line(True, timing)
PY

# The bearer, as a header file on a file descriptor: never an argv.
auth() {
  if [ -n "${RUNNER_TOKEN:-}" ]; then printf 'Authorization: Bearer %s\n' "$RUNNER_TOKEN"; fi
}

# `curl … -w '\n%{http_code}'`: the body, then the status on a line of its own.
call() {
  curl -sS --max-time 120 -H @<(auth) -H 'Content-Type: application/json' -w '\n%{http_code}' "$@" \
    || true # curl still writes -w's 000 on a connection failure
}

now_ms() { date +%s%3N; }

health_raw="$(call "$base/health")"
health_status="${health_raw##*$'\n'}"
health_body="${health_raw%$'\n'*}"
if [ "$health_status" != "200" ]; then
  echo "health  FAIL http $health_status: ${health_body:0:120}"
  exit 1
fi
languages="$(printf '%s' "$health_body" | python3 -c "$JSON_HELPER" languages)"
if [ -z "$languages" ]; then
  echo "health  FAIL no language image on this runner"
  exit 1
fi
echo "health  ok   languages: $languages"

failed=0
for lang in $languages; do
  if ! payload="$(python3 -c "$JSON_HELPER" request "$lang")"; then
    echo "$lang    FAIL advertised, but this script has no program for it"
    failed=1
    continue
  fi
  start="$(now_ms)"
  answer="$(printf '%s' "$payload" | call -X POST --data-binary @- "$base/run")"
  wall=$(( $(now_ms) - start ))
  status="${answer##*$'\n'}"
  body="${answer%$'\n'*}"
  printf '%s' "$body" | python3 -c "$JSON_HELPER" verdict "$lang" "$status" "$wall" || failed=1
done
exit "$failed"
