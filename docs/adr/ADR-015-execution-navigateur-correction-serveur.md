# ADR-015 — The browser executes, the server grades: a `runtime` per code question, a command line per case

## Status

Accepted (2026-09-21, phase 2). Settles the trial-run half of F-QST-09 for the `code`
type, completes `docs/spec/04-types-de-questions.md` §4.7, and lifts decision D14 for the
STUDENT'S Run button only — never for a grade.

## Context

A `code` question of phase 1 could only be tried through the backend runner: the student
presses Run, the API assembles the source, `POST /run` reaches Podman, one container is
created, the sources travel in on `podman exec`'s stdin, the cases run, the container dies.
That is a second of latency at best, one queue slot per keystroke-sized experiment, and
— decision D14 — a `503 runner_unavailable` on every machine without a container engine,
which is every development laptop and every CI runner. A student trying a `printf` should
not need a container, and a classroom of thirty should not spend the runner's four slots on
thirty people fiddling.

Three more facts shaped this:

- **invariant 14**: the source that runs is rebuilt server-side from the template and the
  editable regions. A browser that executes is a browser that also holds the source it
  executes, so the two must not be confused: the one the GRADE is computed from is still
  assembled by the server;
- **invariant 4**: question content only reaches a student through `toStudent`. A browser
  runtime needs the visible cases in the browser — which `toStudent` already publishes —
  and must not need one byte more;
- the `io` mode compares `stdout` and nothing else. A teacher who wants "this program must
  refuse a bad argument with exit 1" has no way to say it, and a teacher who wants
  `./program 3 4` has no way to say that either: `stdin` was the only input a case had.

## Decision

1. **`runtime` says where the STUDENT'S trial run executes, and nothing else.**
   `CodeConfig.runtime` is `backend` (default) or `runno`. It is published to the student
   by `toStudent` because the player needs it to decide what the Run button does; it
   carries no key, and the same view is produced whatever it holds.

2. **`grade()` always goes through `ctx.runner`.** Whatever `runtime` says, the grading
   pass assembles the source server-side, builds a `RunnerRequest` and hands it to the
   backend runner; `finalizeRunnerCode` is the only place a `code` verdict is decided.
   A browser result is not evidence: the page that produced it is the student's, the WASI
   build is not the container's, and nothing signs it. The trial run is an ESSAY — the
   player labels it as such — and the grade is the server's.

3. **The backend is also the fallback.** A browser that cannot start the runtime (no
   `WebAssembly`, no worker, a language `runno` does not ship) falls back on
   `POST /attempts/:id/run`, which is the phase 1 path unchanged, `503 runner_unavailable`
   included when the instance has no engine (decision D14). `runtime: "runno"` is therefore
   an optimisation, never a requirement: a question authored with it still works on an
   instance whose students all fall back.

4. **Runno is WASI in a Web Worker, self-hosted.** The `.wasm` runtimes are served by this
   platform, from this origin, never fetched from `runno.dev` at request time: a classroom
   behind a captive portal must still run, and a third-party origin is one more thing that
   can serve something else tomorrow. The worker gets a 2 s wall clock — the page kills it,
   the way the service kills a container — and a best-effort memory cap through the WASI
   memory the module is instantiated with. `RUNNO_LANGUAGES` is `["c", "python"]`: the two
   the runtime ships and the two this platform's courses use. Every other language of
   `CODE_LANGUAGES` means `backend`, whatever the config says.

5. **The divergences are known, written down, and are the reason the grade is the
   server's.** WASI is not Linux: there is no `fork` and no `exec`, so a program that
   spawns anything fails in the browser and works in the container; there are no signals,
   so a `SIGSEGV` surfaces as a trap with another exit status; `<sys/socket.h>`,
   `<sys/wait.h>` and parts of `<sys/mman.h>` are absent or stubbed; `clock_gettime` and
   `/dev/urandom` are the host browser's, so anything timed or seeded differs; the file
   system is a virtual one, and the teacher's extra `files` are injected there by the page
   rather than by the server. A student whose trial run passes can therefore still fail the
   grading pass, which is exactly why decision 2 exists and why the player says the trial
   is an essay.

6. **A case gets a command line: `args`, an array of strings.** It is `argv[1..]` of the
   program, one element per argument. The runner puts it after the program in the argv it
   already builds — `timeout -s KILL <s> ./program <arg…>` — so an argument is an argument
   of a process and never a fragment of a command line: no shell runs in a container of
   this service, and a space, a quote, a `$` or a `;` inside an element is a character of
   that element. `src/podman.int.test.ts` asserts it against a real container, in C and in
   Python. Invariant 14 is untouched: `args` comes from the STORED config, never from the
   browser — the one exception is the free-stdin try of `POST /attempts/:id/run`, where the
   student types their own command line for a run that is graded by nobody.

7. **A case has TWO independent checks, and must enable at least one.**
   `compareStdout` (default `true`) compares `expected` with the output under
   `tests.compare`; `expectedExitCode` (default `0`, `null` = any code) compares the
   process's exit status. The verdict of a case is:

   > it fails on an accident — the wall clock, the memory ceiling, or no exit code of its
   > own; then every ENABLED check must pass; a disabled check says nothing.

   `compareStdout: false` with `expectedExitCode: null` would be a case that passes
   whatever the program did, so the schema refuses it (`code.case_checks_nothing`).

8. **No version bump.** `args`, `compareStdout`, `expectedExitCode` and `runtime` all have
   a default, so a config stored before this ADR parses unchanged and means exactly what it
   meant: no command line, compare stdout, require exit 0, run on the backend.
   `CODE_CONFIG_VERSION` stays at `1`, and `schema.ts` says why. The canonical YAML leaves
   a default out, so the three-field case of §4.7 still reads and writes as it did.

## Consequences

- The player has two code paths and one verdict rule. `runVisibleCases` applies the same
  two checks `finalizeRunnerCode` applies, so the backend trial run and the grade cannot
  disagree about what a case means; the browser runtime implements the same rule, and a
  disagreement there is a bug in the page and not in the grade.
- `toStudent` publishes more: a visible case's `args`, `compareStdout` and
  `expectedExitCode`. That is deliberate — a visible case is meant to be reproduced by the
  student, command line included — and `expected` is sent only when it is compared, so a
  case that checks the exit code alone publishes no expected output at all. The hidden half
  is unchanged and the leak test now searches for a hidden case's command line too.
- A teacher can write "refuses a bad argument" without writing a program that prints a
  sentence about it, which is the shape most C exercises of the course actually have.
- The runner's flags, its environment list and everything else invariants 10–13 cover are
  untouched: `args` is content of a request, not a capability of a container, and
  `engine.test.ts` asserts the same list flag for flag as before.

## Rejected alternatives

1. **Grade in the browser when `runtime: "runno"`.** It puts the verdict on the student's
   machine. Even with a signature, the page decides what to sign; the only thing that can
   be trusted is the run the server performed.
2. **Make `runno` a platform-wide setting rather than a per-question one.** A question's
   language decides whether a browser can run it at all, and a question with extra `files`
   or an unusual `compileArgs` may want the container. The choice belongs where the
   language does: in the question.
3. **Fetch the runtimes from `runno.dev`.** One CDN outage, one captive portal, or one
   changed artifact, and an exam session is a support ticket. They are ours, on our origin.
4. **`args` as one string, split by the runner.** That is a shell, written badly: the first
   file name with a space, the first quoted argument, and it becomes a parser nobody
   specified. `compileArgs` is the exception this repository already carries (whitespace,
   nothing else, `splitCompileArgs`) and it is not a precedent worth extending to something
   a student's program reads.
5. **A single `check` field with a mode (`stdout` | `exit` | `both`).** Three names for two
   booleans, and no way to say "any exit code, and this output". The two fields are
   independent because the checks are.
6. **Bumping `CODE_CONFIG_VERSION` anyway, "to be safe".** A bump is a migration, and a
   migration that only fills defaults is a migration that can only introduce bugs. The
   defaults are in the schema, where they are applied on every read.
