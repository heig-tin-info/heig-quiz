#!/usr/bin/env python3
"""The runner's self-test against a LIVE service (#234).

One tiny program per language `GET /health` advertises, posted to `POST /run`,
one line per language; exit 1 if /health fails, advertises nothing, or any
language fails. Python 3 standard library only.

    RUNNER_TOKEN=... apps/runner/scripts/smoke.py https://code.chevallier.io:8443
    apps/runner/scripts/smoke.py http://localhost:3200      # a dev runner, no token

The token is read from the environment and stays in this process: it is never
on a command line nor printed. Production runs it from the application VM, the
only address the code VM's Caddy admits (apps/runner/README.md).
"""
import json, os, sys, time, urllib.error, urllib.request

# Each reads 21 and prints 42; spice prints the node voltage of a 42 V source.
# Same programs as `HELLO` in src/podman.int.test.ts.
PROGRAMS = {
    "c": ("main.c", '#include <stdio.h>\nint main(void){int n;if(scanf("%d",&n)!=1)n=0;printf("%d\\n",n*2);return 0;}\n'),
    "cpp": ("main.cpp", '#include <iostream>\nint main(){int n=0;std::cin>>n;std::cout<<n*2<<"\\n";return 0;}\n'),
    "python": ("main.py", "n = int(input())\nprint(n * 2)\n"),
    "js": ("main.js", 'const n = parseInt(require("node:fs").readFileSync(0, "utf8"), 10) || 0;\nconsole.log(n * 2);\n'),
    "rust": ("main.rs", 'use std::io::Read;\nfn main(){let mut s=String::new();std::io::stdin().read_to_string(&mut s).unwrap();let n:i64=s.trim().parse().unwrap_or(0);println!("{}",n*2);}\n'),
    "spice": ("s0.cir", "* smoke\nV1 a 0 42\nR1 a 0 1k\n.op\n.control\nop\nprint v(a)\n.endc\n.end\n"),
}
EXPECT = {"spice": "4.200000e+01"}


def call(base, path, token, payload=None):
    """(status, parsed body or None, raw text); status 0 when nothing answered."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if payload is None else json.dumps(payload).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data, headers), timeout=120) as r:
            status, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode(errors="replace")
    except OSError as e:
        return 0, None, str(getattr(e, "reason", e))
    try:
        return status, json.loads(raw), raw
    except ValueError:
        return status, None, raw


def verdict(lang, status, body, raw, wall):
    """(ok, what) for one language's answer."""
    if status != 200 or not isinstance(body, dict) or "compile" not in body:
        error = body.get("error") if isinstance(body, dict) else raw.strip()[:80] or "no answer"
        return False, f"http {status}: {error}  ({wall} ms)"
    comp = body["compile"]
    if not comp["ok"]:
        first = next((l for l in comp["stderr"].splitlines() if l.strip()), "")
        return False, f"compile error: {first[:100]}  ({wall} ms)"
    if not body["cases"]:
        return False, f"no case ran  ({wall} ms)"
    case = body["cases"][0]
    timing = f"compile {round(comp['ms'])} ms, run {round(case['ms'])} ms, total {wall} ms"
    if case["timedOut"] or case["oom"]:
        return False, f"killed: {'timed out' if case['timedOut'] else 'out of memory'}  ({timing})"
    if case["exitCode"] != 0 or EXPECT.get(lang, "42") not in case["stdout"]:
        first = next((l for l in case["stderr"].splitlines() if l.strip()), "")
        return False, f"exit {case['exitCode']}, stdout {case['stdout'][:40]!r} {first[:80]}  ({timing})"
    return True, timing


def main():
    if len(sys.argv) != 2:
        sys.exit(f"usage: RUNNER_TOKEN=<token> {sys.argv[0]} <base-url>")
    base, token = sys.argv[1].rstrip("/"), os.environ.get("RUNNER_TOKEN", "")
    status, health, raw = call(base, "/health", token)
    languages = health.get("languages", []) if status == 200 and isinstance(health, dict) else []
    if not languages:
        print(f"health  FAIL http {status}: {raw.strip()[:120] or 'no language image on this runner'}")
        return 1
    print(f"health  ok   languages: {' '.join(languages)}")
    failed = False
    for lang in languages:
        if lang not in PROGRAMS:
            ok, what = False, "advertised, but this script has no program for it"
        else:
            name, source = PROGRAMS[lang]
            start = time.monotonic()
            status, body, raw = call(base, "/run", token, {
                "language": lang, "files": [{"name": name, "content": source}], "compileArgs": "",
                "action": "run", "limits": {"timeMs": 5000, "memoryMb": 256, "outputKb": 64},
                "cases": [{"name": "smoke", "args": [name] if lang == "spice" else [], "stdin": "21\n"}],
                "priority": "interactive",
            })
            ok, what = verdict(lang, status, body, raw, round((time.monotonic() - start) * 1000))
        print(f"{lang:<7} {'ok  ' if ok else 'FAIL'} {what}", flush=True)
        failed |= not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
