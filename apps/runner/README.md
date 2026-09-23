# `@quiz/runner` — the code execution service

One HTTP service, two routes, one container per request.

```
POST /run      a RunnerRequest  ->  a RunnerOutcome        (packages/core/src/runner.ts)
GET  /health   a RunnerHealth: languages, queue, engine
```

`POST /run` answers, by design:

| Status | Body | When | What the API does with it |
| --- | --- | --- | --- |
| 200 | a `RunnerOutcome` | served, including "nothing compiled" | uses it |
| 400 | `invalid_request` | the body is not a `RunnerRequest` | `RunnerUnavailable`, no retry |
| 400 | `no_source_file` | no file of that language in the request | `RunnerUnavailable`, no retry |
| 401 | `unauthorized` | no or wrong `Authorization: Bearer` | reported `down` by `/healthz` |
| 429 | `queue_full` + `Retry-After` | both queues are full | `RunnerBusy`; the job waits |
| 503 | `language_unavailable` | no image for that language here | `RunnerUnavailable` |
| 503 | `engine_error`, `upload_failed` | the engine would not start or write | retried once, then `RunnerUnavailable` |

The line between 400 and 503 is whether a RETRY could ever help: `HttpRunner`
sends a 502/503 a second time (`apps/api/src/modules/runner/http.ts`), so
nothing that is the request's own fault belongs on that side.

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
  --name quiz-run-<uuid>
  --label quiz.runner=1                 # this service's containers, all of them
  --label quiz.runner.instance=<uuid>   # THIS process's, drawn once at startup
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
is ever produced, that the environment is exactly those two variables, and —
against a `podman` that records its argv — that every command the engine sends
carries `--remote --url unix://<socket>` (invariant 13).
`src/podman.int.test.ts` proves the consequences on a real engine: no network,
a read-only root, a non-root uid, the memory limit killing, the wall clock
firing, the output truncated, the seccomp profile in force.

**`RUNNER_SECCOMP` is resolved by the Podman SERVER, not by this process.** A
`--remote` client hands the daemon a path and the daemon is what opens it, so
the `existsSync` check in `loadConfig` is a local sanity check only — it
catches a typo on a workstation, and says nothing about the profile the
container actually got. What proves that is a container: `perf_event_open`
comes back `-1 EPERM` under `infra/seccomp/runner.json` and `-1 EFAULT` without
it, which is the assertion in `src/podman.int.test.ts`.

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
   a compile error and not four identical failed cases; `spice` has none at
   all — see below). A failure ends the request there, with an empty case
   list.
5. Each case runs in turn, `timeout -s KILL <limits.timeMs>` inside the
   container and `limits.timeMs + RUNNER_CASE_GRACE_MS` on the service's own
   clock. Both streams are capped at `min(limits.outputKb, RUNNER_MAX_OUTPUT_KB)`,
   and `truncated` says so.

   `cases[].args` follows the program in that argv (`caseArgv` in
   `execute.ts`): `timeout -s KILL <s> ./program <arg…>`, or
   `… python3 main.py <arg…>` for an interpreted language, so the case's
   command line is `argv[1..]` of the student's program — or, in `spice`, the
   netlist to simulate (`… ngspice -b s0.cir`). One element is ONE
   argument, verbatim — a space, a quote, a `$` or a `;` inside it is a
   character of that argument, because no shell runs in a container of this
   service (`languages.ts`). `src/podman.int.test.ts` proves it against a real
   container, in C and in Python.
6. The container is destroyed in a `finally`.

The container is NOT created with `--rm`: it has to outlive the process that
ran in it, so a case that timed out can be inspected and the next case can
reuse the same container. What `finally` cannot cover is the service dying
between `create` and it — an OOM on the host, a restart, a crash. The
container survives that: its only process is `sleep <ttl>`, so it stays **`Up`**
until the ttl runs out, holding its name and its share of the host.

`pruneOrphans()` therefore runs once at startup. It **lists** the containers
labelled `quiz.runner=1`, and removes only those whose
`quiz.runner.instance` is not this process's — a blind
`rm -f --filter label=quiz.runner=1` would force-kill the running containers of
a co-tenant instance, or of the old process still draining its queue during a
restart, and a student's answer with them. It is never a reason not to start:
a failure is one log line and the service serves.

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
images/build.sh                 # c cpp python js spice
images/build.sh rust            # ~700 MB, never built by default
```

| Image | Base | What is in it | Size |
| --- | --- | --- | --- |
| `quiz-runner-c` | alpine 3.20 | `gcc`, `musl-dev` | ~160 MB |
| `quiz-runner-cpp` | alpine 3.20 | `g++`, `musl-dev` | ~220 MB |
| `quiz-runner-python` | alpine 3.20 | `python3` | ~50 MB |
| `quiz-runner-js` | alpine 3.20 | `nodejs` | ~170 MB |
| `quiz-runner-rust` | alpine 3.20 | `rust`, `cargo` | ~700 MB, on demand |
| `quiz-runner-spice` | alpine 3.20 | `ngspice` (42) | ~65 MB |

Alpine-based, one toolchain each, a non-root `uid 1000` — asserted image by
image, by a program that prints its own uid (`src/podman.int.test.ts`) — no
network client, no package manager needed at run time. `GET /health` lists the languages whose
image is present; `POST /run` answers `503 language_unavailable` for the
others — the runner never pulls anything (it has no registry credentials and,
in production, no route to a registry).

### `spice`: a simulator, served as a language

The `circuit` question type (`packages/qt-circuit`) is graded by SIMULATING
the student's schematic and comparing the output waveform with the
reference's (ADR-019). ngspice therefore rides the existing path, unchanged:
one image, one entry in `SPECS` (`languages.ts`), the same hardened container,
the same queues, the same limits. No flag was relaxed for it and no
environment variable was added — `src/engine.test.ts` asserts the container's
argv flag for flag and did not change.

Two things are specific to it:

- **Nothing is built.** `compile` is `null`, so `compile.ok` is true by
  definition and a malformed netlist reaches the student as a FAILED CASE —
  ngspice exits non-zero and says why — not as a compile error. ngspice has
  no check mode to borrow, unlike `py_compile` for Python.
- **The argv carries the netlist**, not the run plan. A request holds one
  schematic and several stimuli: one file per stimulus (`s0.cir`, `s1.cir`,
  …, all rebuilt server-side by the question type — invariant 14) and one
  case per stimulus, named `s0`, `s1`, …, with `args: ["s0.cir"]`. The argv
  is therefore `timeout -s KILL <s> ngspice -b s0.cir`, and one container
  serves every stimulus of one answer. A case with NO argument is not a hang:
  `ngspice -b` then reads its stdin, which the engine closes at once, and it
  exits 1 with "no simulations run" in a few milliseconds (verified on
  ngspice 42, `src/spice.int.test.ts`).

**The `podman run` outside `containerArgs()`.** There are two, and neither
runs a student's program: the startup probe starts a throwaway `true` to find
out whether `--userns=auto` works (`src/probe.ts`, `--rm --pull=never
--userns=auto --network none`), and the suite below.
`packages/qt-circuit/src/spice.int.test.ts` validates the netlists that type
emits against a real ngspice, and cannot call `executeRequest`: `@quiz/runner`
is an app (ADR-016) and no `packages/*` depends on an app. It therefore repeats
the flags of `containerArgs()` itself — `--remote --url`, `--cap-drop=ALL`,
`no-new-privileges`, this package's seccomp profile, `--read-only`, both tmpfs,
`--pids-limit`, `--memory` without swap, `--cpus`, `--network none` — with ONE
relaxation, stated here rather than in a comment: **`--userns=auto` is not
passed there.** The service probes it once at startup against a real image and
drops it when the engine cannot do it; a test has no such probe, and passing
the flag blindly would make the suite fail on a rootless workstation instead of
telling it anything about ngspice. Nothing else is relaxed, nothing is mounted,
and the containers are `--rm` and unlabelled, so `pruneOrphans()` ignores them.

**What was checked about `.control` blocks.** ngspice's batch mode executes
the `.control` section of the netlist, and that section has commands that
touch the host: `shell` runs a command, `source` and `load` read a file,
`write` writes one. They were all tried inside the container of this service.
`shell id` answers `uid=1000(runner)`; `shell cat /etc/shadow` is *Permission
denied*; `shell touch /etc/pwned` and `write /etc/out.raw` are *Read-only file
system*; `shell ping` is *permission denied (are you root?)* because
`--cap-drop=ALL` took `CAP_NET_RAW`, and there is nothing to reach anyway with
`--network none`; `load` reads only what is already in the image or in the
`/work` tmpfs. So the sandbox answers, not the parser — which is the point of
invariants 11 and 12. The second line of defence is that a student never
writes a netlist: the type assembles it from the schematic and the teacher's
stimuli (invariant 14), so no `.control` block of a student's making is ever
submitted.

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

Everything is in `src/config.ts`, validated at startup.

| Variable | Default | What it settles |
| --- | --- | --- |
| `PORT` | 3200 | The port; `HOST` is `0.0.0.0` of its own namespace. |
| `PODMAN_BIN` | `podman` | The binary. `podman-remote` works; `docker` does not. |
| `PODMAN_SOCKET` | auto | User socket, then the rootful one. |
| `PODMAN_REMOTE` | auto | `false` drives the local CLI: the escape hatch. |
| `RUNNER_CONCURRENCY` | 4 | Containers at a time. |
| `RUNNER_QUEUE_MAX` | 32 | Waiting requests before `429`. |
| `RUNNER_IMAGE_PREFIX` / `_TAG` | `quiz-runner` / `latest` | `quiz-runner-c:latest`. |
| `RUNNER_SECCOMP` | the profile shipped here | Resolved by the Podman server (above). |
| `RUNNER_USERNS_AUTO` | auto | Probed once at startup. |
| `RUNNER_RUNTIME` | auto | `runsc` when the host has gVisor. |
| `RUNNER_MAX_OUTPUT_KB` | 256 | Ceiling on `limits.outputKb`, per stream and per case. |
| `RUNNER_MAX_MEMORY_MB` | 512 | Ceiling on `limits.memoryMb`, per container. |
| `RUNNER_MAX_TIME_MS` | 20 000 | Ceiling on `limits.timeMs`, per case. |
| `RUNNER_WORKDIR_MB` | 32 | Size of the `/work` and `/tmp` tmpfs. |
| `RUNNER_COMPILE_TIMEOUT_MS` | 20 000 | Budget of the build step. |
| `RUNNER_CASE_GRACE_MS` | 2000 | How long past a case's deadline the service waits. |
| `RUNNER_REQUEST_TIMEOUT_MS` | 120 000 | Ceiling on a whole request, all cases together. |

The three `RUNNER_MAX_*` ceilings default to the upper bounds of
`RunnerRequest.limits` (`packages/core/src/runner.ts`), so a fresh deployment
clamps nothing. They exist because that schema is the CALLER's contract — what
a question type may write — and not a statement about what this machine can
afford: a VM with 4 GB for four concurrent containers lowers
`RUNNER_MAX_MEMORY_MB` and every request is capped, whatever it asked for
(`effectiveLimits` in `execute.ts`).

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
its rootful socket — with the seccomp profile installed on the host at
`/etc/quiz-runner/seccomp.json`, since a `--remote` client hands the server a
path and the server is what opens it — a Caddy fragment that exposes it as
`https://code.chevallier.io:8443` to the quiz VM's address only, an
`env.example` for `/etc/quiz-runner/env`, and the `deploy.sh` the CI's
forced-command key is pinned to.
