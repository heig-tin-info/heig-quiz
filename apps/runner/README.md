# `@quiz/runner` — the code execution service

One HTTP service, two routes, one container per request.

```
POST /run      a RunnerRequest  ->  a RunnerOutcome        (packages/core/src/runner.ts)
GET  /health   a RunnerHealth: languages, queue, engine
```

The API talks to it through `apps/api/src/modules/runner/http.ts` when
`RUNNER_MODE=http`. With `RUNNER_MODE=stub` — the default everywhere, and the
only possibility on a machine without a container engine — nothing here is
needed and a code question stays authorable, playable and releasable
(decision D14).

## Where the hardening comes from

The flag list, the seccomp profile and the invariants are lifted from the
sibling project **`~/heig-codespace`** (same author, same stack), where they
are in production: `images/c-dev/run-hardened.sh`, `infra/seccomp/codespace.json`
and the engine module `src/engine/`. They arrived in this repository as
`apps/runner/_from-codespace/`, which this package replaces; the seccomp
profile now lives at `infra/seccomp/runner.json`, unchanged, and the
`c-dev` image's structure is what `images/*/Containerfile` is derived from,
with code-server, gdb, git and every network client dropped.

What was deliberately *not* carried over:

| Dropped | Why |
| --- | --- |
| `--network codespace`, `--dns=none`, `--add-host` | A quiz runner has no git channel to open: `--network none`, and Podman refuses `--dns=none` with it. |
| `--security-opt apparmor=codespace` | That profile exists to let `gdb` ptrace inside a codespace. Nothing here debugs; Podman's built-in profile applies when the host has AppArmor. |
| `-v <dir>:/work:U` | Nothing from the host is mounted, ever. `/work` is a tmpfs and the sources travel in on `podman exec`'s stdin. |
| code-server, gdb, git, curl | An editor is not a grader. |

## The flags of every container

```
podman --remote --url unix://<socket> run -d
  --name quiz-run-<uuid> --label quiz.runner=1
  --userns=auto                       # rootful always; rootless when subuid allows (probed)
  --cap-drop=ALL
  --security-opt no-new-privileges
  --security-opt seccomp=infra/seccomp/runner.json
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=<RUNNER_WORKDIR_MB>m
  --tmpfs /work:rw,exec,nosuid,nodev,size=<RUNNER_WORKDIR_MB>m,mode=1777
  --pids-limit 64
  --memory <limits.memoryMb>m --memory-swap <same>   # no swap, or a memory bomb pages instead of dying
  --cpus 1
  --network none
  [--runtime runsc]                   # when the host has gVisor
  -e HOME=/work -e LANG=C.UTF-8       # the CLOSED list, asserted by a test
  quiz-runner-<lang>:latest sleep <ttl>
```

`src/engine.test.ts` asserts that list flag for flag, that no `-v`/`--mount`
is ever produced, and that the environment is exactly those two variables.
`src/podman.int.test.ts` proves the consequences on a real engine: no network,
a read-only root, a non-root uid, the memory limit killing, the wall clock
firing, the output truncated.

### Rootless vs rootful

| | development workstation | production VM |
| --- | --- | --- |
| Engine | rootless Podman, user socket `/run/user/<uid>/podman/podman.sock` | rootful Podman, `/run/podman/podman.sock` |
| `--remote --url` | yes (invariant 13) | yes |
| `--userns=auto` | probed once at startup: it works when `/etc/subuid` gives the user a range; the flag is dropped, with a log line, when it does not | always |
| Everything else | identical | identical |

`RUNNER_USERNS_AUTO=auto|true|false` forces the matter either way.
`PODMAN_SOCKET` is auto-detected (user socket, then rootful) and
`PODMAN_REMOTE=false` drives the local CLI instead — the escape hatch for a
host whose Podman service is not running, not the normal path.

## How a request is served

1. The two queues (`interactive` before `grading`, `RUNNER_CONCURRENCY`
   containers at a time) hand the request to `execute.ts`, or answer `429`
   with a `Retry-After` past `RUNNER_QUEUE_MAX`.
2. One container is created with the flags above, `sleep <ttl>` its only
   process.
3. Each file is written with `podman exec -i … cp /dev/stdin <name>`. The name
   is sanitized first: no directory, nothing outside `[A-Za-z0-9._-]`, no
   leading `-`. No shell ever sees it — every command is an argv.
4. The language's build step runs once (`gcc`, `g++`, `rustc`, or
   `py_compile`/`node --check` for the interpreted ones, so a syntax error is
   a compile error and not four identical failed cases). A failure ends the
   request there, with an empty case list.
5. Each case runs in turn, `timeout -s KILL <limits.timeMs>` inside the
   container and `limits.timeMs + RUNNER_CASE_GRACE_MS` on the service's own
   clock. Both streams are capped at `min(limits.outputKb, RUNNER_MAX_OUTPUT_KB)`,
   and `truncated` says so.

   `cases[].args` follows the program in that argv (`caseArgv` in
   `execute.ts`): `timeout -s KILL <s> ./program <arg…>`, or
   `… python3 main.py <arg…>` for an interpreted language, so the case's
   command line is `argv[1..]` of the student's program. One element is ONE
   argument, verbatim — a space, a quote, a `$` or a `;` inside it is a
   character of that argument, because no shell runs in a container of this
   service (`languages.ts`). `src/podman.int.test.ts` proves it against a real
   container, in C and in Python.
6. The container is destroyed in a `finally`.

`timeout` and a cgroup OOM kill both end as exit 137, so the elapsed time
tells them apart: at the deadline it is `timedOut`, well before it is `oom`.
When the service's own clock has to fire, or when the OOM killer took the
container down with it, the container is rebuilt and the remaining cases still
run.

**`cases[].timeMs` on the wire.** `RunnerRequest` carries one budget for the
whole request (`limits.timeMs`) and no per-case one: `buildRunnerRequest` in
`packages/qt-code` asks for the LARGEST budget of the cases it sends, and
`finalizeRunnerCode` re-applies each case's own limit to the measured time
(deviation W3-2). So every case here gets `limits.timeMs`, and `ms` is
measured around the `podman exec` call — it carries a few tens of
milliseconds of engine overhead, which is why a per-case budget below ~200 ms
is not a useful thing for a teacher to write.

## The images

```bash
images/build.sh                 # c cpp python js
images/build.sh rust            # ~700 MB, never built by default
```

Alpine-based, one toolchain each, a non-root `uid 1000`, no network client, no
package manager needed at run time. `GET /health` lists the languages whose
image is present; `POST /run` answers `503 language_unavailable` for the
others — the runner never pulls anything (it has no registry credentials and,
in production, no route to a registry).

## Running it here

```bash
pnpm --filter @quiz/runner dev          # :3200, or one line and exit 0 without a socket
pnpm --filter @quiz/runner test         # unit: a fake engine, no container
pnpm --filter @quiz/runner test:integration   # real containers, skipped without Podman
```

`pnpm dev` at the root starts the API, the SPA **and** the runner, the last one
only if a Podman socket is there. Point the API at it with
`RUNNER_MODE=http` and `RUNNER_URL=http://localhost:3200` in `.env`.

## Configuration

Everything is in `src/config.ts`, validated at startup. The ones that matter:
`PORT` (3200), `PODMAN_SOCKET` (auto), `PODMAN_REMOTE` (auto), `PODMAN_BIN`,
`RUNNER_CONCURRENCY` (4), `RUNNER_QUEUE_MAX` (32), `RUNNER_IMAGE_PREFIX`
(`quiz-runner`), `RUNNER_SECCOMP` (the profile shipped here),
`RUNNER_USERNS_AUTO` (auto), `RUNNER_RUNTIME` (auto — `runsc` when the host
has gVisor), `RUNNER_MAX_OUTPUT_KB` (256), `RUNNER_WORKDIR_MB` (32),
`RUNNER_COMPILE_TIMEOUT_MS` (20 000), `RUNNER_CASE_GRACE_MS` (2000),
`RUNNER_REQUEST_TIMEOUT_MS` (120 000).

`RUNNER_TOKEN` is the one exception to "no secret": the shared bearer the API
presents on every call, checked on both routes in constant time, required in
production (`loadConfig` refuses to start without it there) and never passed
into a container. It exists because the service runs on a VM of its own,
behind TLS, and would otherwise answer anyone (ADR-016).

**No other secret belongs here.** The runner holds no credential, reaches no
database and passes nothing of its own environment into a container.

## In production

`deploy/` holds the whole of it (ADR-016, `deploy.md` § Runner): a Podman
quadlet (`quiz-runner.container`) that runs this image on the code VM against
its rootful socket, a Caddy fragment that exposes it as
`https://quiz-runner.chevallier.io` to the quiz VM's address only, an
`env.example` for `/etc/quiz-runner/env`, and the `deploy.sh` the CI's
forced-command key is pinned to.
