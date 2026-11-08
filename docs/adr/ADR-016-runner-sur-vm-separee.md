# ADR-016 — The code runner on the codespace VM, behind Caddy, with a shared token

## Status

Accepted (2026-09-21, first production deployment). Amended 2026-09-25,
2026-09-30, 2026-10-07, 2026-10-08, 2026-10-11 (twice), 2026-10-12 and
2026-10-26. Every rule the amendments added is under
[Amendments in force](#amendments-in-force), where nothing of the runner's
hardening (root `CLAUDE.md` invariants 10–13) is relaxed; their dated text,
with the reasons and the transitions, is in the [historical record](history/ADR-016-runner-sur-vm-separee.md#status).

- **2026-10-11 (security audit M6, L12, L13): gVisor is the default runtime of the runner's own Podman service** (`runsc --oci-seccomp`), never a `containerArgs` flag; `RUNNER_RUNTIME=runsc` makes the runner refuse to start unless a real container runs under it (`proveRuntime`); the runner binds the loopback ([amendment](#2026-10-11-gvisor-the-containers-state-the-bind-address)).
- 2026-10-11 (security audit H4): the staging portal deploys only once approved, through a frozen dispatcher ([amendment](#2026-10-11-the-staging-portal-deploys-only-once-approved)).
- 2026-10-08 (M6-05 part 2): the engine VM's cgroup slices (`--cgroup-parent`), backups and host firewall ([amendment](#2026-10-08-capacity-and-backups-of-the-engine-vm)).
- 2026-10-07 (M6-04): one deploy dispatcher, two portal instances, an image per sha, the live-session guard ([amendment](#2026-10-07-the-portal-deployed-beside-the-runner)).
- 2026-09-30 (ADR-035): the engine VM also hosts the online workspace portal ([addendum](#2026-09-30-the-portal-shares-the-engine-vm)).
- 2026-09-25: the application VM moved to Hetzner ([update](#update-2026-09-25)).
- 2026-10-12, [ADR-106](ADR-106-notation-des-projets-par-criteres.md) §3 (point 2): a second action, `project`, with its lab image (`lab-c`); the flags of `containerArgs` do not change, invariants 10–14 hold, invariant 12 gaining the archive rule. To leave with card L-06g, once the last v2 snapshot is released ([ADR-119](ADR-119-criteres-v3-preuves-de-la-ci.md) §10, 2026-10-26); the runner then executes question code only.
- See also [ADR-101](ADR-101-budget-du-runner.md) (2026-10-11): the runner's capacity budget, relying on the 2026-10-08 sizing.

## Context

`docs/spec/05-architecture.md` (5.5 and 5.9) and ADR-009 put the runner in the
production compose file, next to the API, with the host's Podman socket mounted.
That assumed a VM of the platform's own.

The platform is deployed instead on the VM that already runs heig-classroom and
evaluation-tb (`classroom.chevallier.io`, 1 CPU, 956 MiB, Docker, a native Caddy
importing one fragment per service). That machine has no Podman, and no room for
student compilations next to two PostgreSQL servers and three Node processes. The
sibling codespace project runs on a second VM (`code.chevallier.io`, 2 CPUs, 4 GB)
whose rootful Podman 5.7 socket, seccomp habits and `--userns=auto` allocation are
exactly what `apps/runner` was written against (invariants 10–14).

The runner, as shipped, had no authentication: it was reachable on the internal
compose network only.

## Decision

1. **The application stack** (`app`, `postgres`, `backup`) runs on the classroom VM
   in `/opt/quiz`, published on `127.0.0.1:3002` (3000 and 3001 belong to the
   neighbours), behind the fragment `/etc/caddy/conf.d/quiz.caddy` for
   `quiz.chevallier.io`. Its PostgreSQL gets the same low-memory tuning as the
   classroom's. Nothing of the neighbours is touched.
2. **The runner** runs on the code VM as a Podman quadlet
   (`apps/runner/deploy/quiz-runner.container`): the CI image, host networking bound
   to `127.0.0.1:3200`, the rootful socket and the seccomp profile as its only
   mounts (the profile is opened by the Podman server, so it has to be a host
   path), read-only root, no capability. The sandbox containers it starts are unchanged. The language images
   are built on that VM from `apps/runner/images/`, its only supply chain.
3. **The link between the two is HTTPS with two gates.** The code VM's Caddy serves
   the runner on `https://code.chevallier.io:8443` (fragment
   `apps/runner/deploy/Caddyfile`): the VM's existing name and certificate, a port
   of its own so the codespace's `:443` site block is untouched — and answers 403 to
   any source address but the classroom VM's. The runner itself requires
   `Authorization: Bearer <RUNNER_TOKEN>` on both routes, compared in constant time;
   the API sends it on every call. Production refuses to start without the token on
   either side (`config.ts` of both). `/health` is guarded too, so a wrong token is a
   runner reported `down` by `/healthz`, not one that says `up` and refuses every run.
4. **One CI key, two forced commands.** The `deploy` job SSHes to both VMs with the
   same key, pinned to `/opt/quiz/deploy.sh` on one and `/opt/quiz-runner/apps/runner/deploy/deploy.sh`
   on the other; each pulls its image with the CI's ephemeral GHCR token and restarts.
   The code VM's `/etc/caddy/Caddyfile` — owned by heig-codespace — gained a single
   `import /etc/caddy/conf.d/*.caddy` line, the convention the classroom VM already
   follows.

## Consequences

- Student code compiles on the machine sized for it, and a memory bomb in a grading
  pass cannot starve the classroom's PostgreSQL.
- The runner is a network service now. The token is a secret the runner holds
  (`/etc/quiz-runner/env`), the one exception to "no secret here" — it is never passed
  into a sandbox container, which invariant 10's closed list still asserts.
- One DNS record (`quiz`), one port to keep open on the code VM (8443, for the
  classroom VM's address), two VMs to keep patched. The runner being down degrades to decision D14: a
  code question is graded by proposal, and `/healthz` says so.
- A `podman-remote` client of the same major version as the code VM's engine
  (5.7) is pinned in `apps/runner/Dockerfile`; upgrading the VM's Podman means
  bumping the pin.
- The spec's 5.9 is amended by a pointer to this record rather than rewritten.

## Rejected alternatives

1. **Podman on the classroom VM, runner in the compose file as specified**: no CPU
   and no memory to spare there, and a second container engine next to Docker on a
   1-CPU machine for the benefit of a few compilations a day.
2. **A WireGuard tunnel between the VMs, runner unauthenticated**: a second piece
   of infrastructure to keep alive for what a source-address filter plus a bearer
   already give, with TLS from a certificate Caddy renews on its own.
3. **A name of its own, `quiz-runner.chevallier.io` on 443**: one more record and
   one more certificate for what the VM's existing name already gives; the port is
   the only thing to remember, and it lives in one `.env.prod` line.
4. **Plain HTTP on a firewalled port**: student code and outputs in clear across the
   internet, for no saving.

## Amendments in force

### 2026-09-30: the portal shares the engine VM

*ADR-035, the classroom merge.* The code VM (`code.chevallier.io`, "the
engine VM") also hosts the online workspace portal (`apps/codespace`,
ADR-047); the merge adds no VM. The runner and the portal each run in their
own cgroup slice (`CPUWeight`, `MemoryMax`) so that the sessions of an exam
cannot starve grading, with orphan reaping scoped by label and one CI
deploy dispatcher behind the forced command. `apps/codespace` keeps its own
`CLAUDE.md` with its two sanctioned divergences from invariants 11–12 (a
persistent work volume, a git channel on an internal bridge); invariants
10–14 remain those of `apps/runner`. Plan: `docs/merge/06-codespace-seb-infra.md` §6.2.

### 2026-10-07: the portal deployed beside the runner

*M6-04; scope: point 4 and the addendum above; the runner's own deploy
steps are unchanged.*

- **One dispatcher.** `infra/engine/deploy.sh` is the engine VM's forced
  command; the production key runs it on `/opt/quiz-runner` (the runner and
  the portal's `prod`). It parses `[force] <component> <instance> <sha>
  <token>` strictly, serialises the VM's deploys with one lock, **refuses a
  sha that predates it**, moves its checkout and runs the component's steps
  (`apps/runner/deploy/install.sh`, `apps/codespace/deploy/install.sh
  <instance>`), which share `infra/engine/lib.sh` (pull and retag by sha,
  untag older sha tags; **no global prune** on an engine other services
  share). It **refuses the staging scope** (2026-10-11, below). *Transition:*
  it still accepts the runner's pre-M6-04 `<sha> <token>`, which
  `apps/runner/deploy/deploy.sh` forwards to it (a TODO in the dispatcher).
- **Two portal instances**, `prod` (`code.chevallier.io`) and `staging`
  (`code-dev.chevallier.io`, for `quiz.dev.chevallier.io`), with separate
  environment files, secrets, ports, data directories, SQLite and volumes.
  Every session container carries `heig-codespace.instance=<CODESPACE_INSTANCE>`
  and a name prefixed with it, and an instance lists only its own. Each
  instance has its own Podman network and bridge (`cs0`, `cs1`), the
  nftables table pinning each bridge to its own gateway, so a staging
  container cannot reach production's git channel; the channel has **no
  `0.0.0.0` fallback** in production or for a named instance: no gateway,
  no start.
- **An image per sha.** The portal is built by the CI
  (`ghcr.io/heig-tin-info/quiz-codespace:<sha>`, `apps/codespace/Dockerfile`,
  **no secret inside**) and runs as a quadlet like the runner: host
  network, the rootful socket, the data directory bound at the same path,
  **read-only root, no capability**. The student image is built on the VM
  by hand (`apps/codespace/images/build.sh`), **never by a deploy, never
  pulled**.
- **The live-session guard.** A `prod` deploy **refuses (exit 3)** while a
  session container of that instance runs, unless the request starts with
  `force` (CI: `CODESPACE_FORCE_SHA` naming the run's sha); `staging` is not
  guarded.
- **Host-level pieces** (the nftables table, the AppArmor profile, the
  network and shadow units, under `/usr/local/lib/quiz-codespace`) are
  written by the bootstrap and by a `prod` deploy only, **never by a staging
  deploy**: this prevents accidents, not attacks. Operations:
  `apps/codespace/deploy/RUNBOOK.md`. The portal holds **no GitHub App key**
  (`FORGE_KIND=none`, root invariant 15).

### 2026-10-08: capacity and backups of the engine VM

*M6-05 part 2; scope: the addendum's resize and slices; the backups this VM
lacked.*

- **No resize** while the workspace is test-only (owner); a real class
  needs it.
- **Two slices**, `quiz-runner.slice` above `codespace.slice` in CPU and IO
  weight, the runner's memory protected, the workspace's capped
  (`infra/engine/*.slice`); containers join theirs through
  **`--cgroup-parent`, an addition to invariant 12's list**, set by the
  quadlets.
- **Backup, destination A** (stopgap): a root forced command (`restrict`,
  `from=`) streams each instance's SQLite `.backup` and volumes; `srv` on the
  app VM pulls it daily. **No credential travels**: env files stay in the
  vault (ADR-010), session cookie tokens are blanked in the copy. Accepted
  limits: volumes are read live (a repository may need its `shadow.git`), one provider, the app VM's small disk, a
  key that reads all workspace data, monitoring by hand (not in ADR-055's
  status). **Destination B**, restic to S3 from the engine VM, before a real
  class. Procedures: `deployment.md` §3.
- **The host's input policy drops by default**, in its own table
  `inet host`, **never with `flush ruleset`** (the codespace and netavark
  tables belong to their owners); applied by hand behind a timed rollback,
  **never by a deploy**.

### 2026-10-11: gVisor, the container's state, the bind address

*Security audit M6, L12, L13; scope: point 2 (what the sandbox containers
run under) and the runner's startup; invariants 10–14 are unchanged.*

- **gVisor is the Podman service's runtime, never a flag.** A `--remote`
  client rejects `--runtime`. gVisor is the default runtime of the runner's
  own Podman service, `quiz-runner-podman.socket`
  (`/run/quiz-runner-podman/podman.sock`), whose `CONTAINERS_CONF_OVERRIDE`
  names a wrapper running **`runsc --oci-seccomp`** — without that flag
  runsc ignores the seccomp profile of invariant 12. The system socket keeps
  crun for the workspace portal. One script,
  `apps/runner/deploy/install-gvisor.sh`, sets it up on the VM and on CI.
- **Fail-closed on demand** (owner). With `RUNNER_RUNTIME=runsc` the runner
  **refuses to start** unless the engine names runsc, a container created
  with the argv of a real run executes a command through `podman exec`, and
  that command sees another kernel release than the host's (`proveRuntime`);
  the quadlet restarts it, `/healthz` reports it down, the ADR-055 alert
  fires. With `auto` (the default) a production runner without gVisor warns
  once, at startup; `none` is the explicit derogation, without that warning.
  The owner installs gVisor and flips the variable by hand; **no deploy
  does** (`apps/runner/README.md`, Switching production to gVisor).
- **The proof before production**: the runner integration workflow's
  `runsc` leg runs the whole suite through that socket and blocks like the
  `default` leg (#736). Under gVisor the profile's refusals answer EPERM,
  never ENOSYS (runsc ignores `errnoRet` and `defaultErrnoRet`), and the
  suite expects exactly that on that leg.
- `RunnerHealth` carries an optional `runtime`, tolerated absent on both
  sides.
- A program's stderr or exit code only triggers a `podman container
  inspect`, whose answer alone says the container is gone.
- **The runner binds `127.0.0.1` by default and refuses a bind outside the
  loopback without `RUNNER_TOKEN`.**

### 2026-10-11: the staging portal deploys only once approved

*Security audit H4; scope: the staging half of the M6-04 amendment;
production's path is unchanged. The owner chose this over a separate
staging VM.*

- **An approval before anything of a commit reaches this VM.** The `staging`
  key no longer reaches it: the staging portal is deployed by its own CI
  job, in a `staging-portal` environment with the same required reviewers
  and `main`-only rule as `production`, by a key that environment alone
  holds. An environment created unprotected on first use holds no key, so
  the job then deploys nothing. Nothing waits for that job.
- **The frozen dispatcher.** That key's forced command is a copy of
  `infra/engine/staging-dispatch.sh` the operator installs by hand outside
  any checkout, root's, that **no deploy rewrites**: it pulls the portal
  image by digest and restarts the staging quadlet, and **runs, sources and
  writes no file of a commit** (a shell test in `checks` holds it to its
  header). `infra/engine/deploy.sh` refuses the staging scope; the staging
  checkout is retired.
- **Who writes the staging instance's files**: its quadlet, Caddy site and
  seccomp profile come from approved commits only, written by every `prod`
  portal deploy and by `bootstrap.sh`. Installing the dispatcher is an
  operator's step (`deployment.md` §4); a production deploy warns when the
  checkout's copy differs from the installed one.
- **Production keeps running its commit's scripts as root**: the approval of
  the `production` environment is what makes that commit trusted here.
- **Closed under two conditions the repository cannot enforce**: the staging
  portal's image still runs with the rootful Podman socket, so an image that
  reaches this VM is root-equivalent on it. It holds while the
  `staging-portal` environment keeps its required reviewers and `main` rule
  and is the only place its key lives (`deployment.md` §4, *The
  environments*), and while a reviewer approves only a sha they would
  promote to production.
- *Rejected*: `deploy.sh` delegating its staging scope to the frozen script;
  a separate staging VM or a rootless staging engine (for now); a gate in
  the workflow alone, without moving the key.

## Update 2026-09-25

The application VM is now the Hetzner Cloud VM `portal.heig.chevallier.io`
(CPX12, 1 vCPU, 2 GB + 2 GB swap), shared with heig-classroom and evaluation-tb
as before; `quiz.chevallier.io` is a CNAME to it. The stack lives in
`/srv/quiz` and runs as the `srv` account on rootless Docker, and the CI key is
pinned in `/home/srv/.ssh/authorized_keys` (`DEPLOY_USER=srv`). The runner's
Caddy allowlist names the new address, `128.140.71.35`. The runner VM is
unchanged. The [deployment runbook](../development/deployment.md) holds the current layout.
