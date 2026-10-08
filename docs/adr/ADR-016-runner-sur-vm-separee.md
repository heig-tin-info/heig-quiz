# ADR-016 — The code runner on the codespace VM, behind Caddy, with a shared token

## Status

Accepted (2026-09-21, first production deployment).

**Addendum (2026-09-30, ADR-035, the classroom merge):** the code VM
(`code.chevallier.io`, "the engine VM") also hosts the online workspace
portal (`apps/codespace`, ADR-047), which already runs there natively
today. The merge adds no VM: the runner and the portal share it, each in
its own cgroup slice (`CPUWeight`, `MemoryMax`) so that the sessions of an
exam cannot starve grading, with orphan reaping scoped by label and one
CI deploy dispatcher behind the forced command. The VM is resized before
a real class uses the portal. `apps/codespace` keeps its own `CLAUDE.md`
with its two sanctioned divergences from invariants 11–12 (a persistent
work volume, a git channel on an internal bridge); invariants 10–14
remain those of `apps/runner`. The plan is
`docs/merge/06-codespace-seb-infra.md` §6.2; it ships with phase M6,
after the cutover (D09, settled 2026-10-01).

**Amended (2026-10-07, M6-04): how the portal is deployed beside the
runner.** Scope: point 4 below and the addendum above; the runner's own
deploy steps are unchanged.
(a) *One dispatcher, two checkouts.* `infra/engine/deploy.sh` is the
engine VM's forced command for both components, with a scope fixed by the
`authorized_keys` line: the production key runs the dispatcher of
`/opt/quiz-runner` (the runner and the portal's `prod`), the staging key
the dispatcher of its own clone `/opt/quiz-engine-staging` (the portal's
`staging` only), so the production checkout only ever moves to approved
commits. It parses `[force] <component> <instance> <sha> <token>`
strictly, serialises the VM's deploys with one lock, refuses a sha that
predates it, moves its checkout and runs the component's steps
(`apps/runner/deploy/install.sh`, `apps/codespace/deploy/install.sh
<instance>`), which share `infra/engine/lib.sh` (pull and retag by sha,
then untag the older sha tags; no global prune on an engine other services
share). *Transition:* it also accepts the runner's pre-M6-04 `<sha>
<token>`, which the CI keeps sending, and the former
`apps/runner/deploy/deploy.sh` forwards to it, so the existing key line
keeps deploying and the first deploy hands over from the old script. Once
`authorized_keys` names the dispatcher, the CI sends `runner prod <sha>
<token>` and both go (a TODO in the dispatcher).
(b) *Two portal instances on the VM*, `prod` (`code.chevallier.io`, for
production) and `staging` (`code-dev.chevallier.io`, for
`quiz.dev.chevallier.io`), with separate environment files and secrets,
ports, data directories, SQLite and volumes. Because a portal removes the
session containers its database does not know, every session container
carries `heig-codespace.instance=<CODESPACE_INSTANCE>` and a name
prefixed with it, and an instance lists only its own (both labels in the
`ps` filter). Each instance has its own Podman network and bridge (`cs0`,
`cs1`), the nftables table pinning each bridge to its own gateway, rather
than one shared bridge: the git channel authenticates a push by source
address against its own database, so a staging container must not reach
production's channel at all. For the same reason the channel has no
`0.0.0.0` fallback in production or for a named instance: no gateway, no
start (the deploy replays the network setup first).
(c) *An image per sha.* The portal is built by the CI
(`ghcr.io/heig-tin-info/quiz-codespace:<sha>`, `apps/codespace/Dockerfile`,
no secret inside) and runs as a quadlet like the runner — host network,
the rootful socket, the data directory bound at the same path, read-only
root, no capability — rather than as a `pnpm deploy` tarball on the
host's Node: the build happens once, on the image's own glibc, and the
deploy is the runner's (pull by sha, retag, restart). The student image
follows the runner's language images: built on the VM by hand
(`apps/codespace/images/build.sh`), never by a deploy, never pulled.
(d) *The live-session guard.* A `prod` deploy refuses (exit 3) while a
session container of that instance runs, unless the request starts with
`force` (CI: `CODESPACE_FORCE_SHA` naming the run's sha), as the
application's live-evaluation guard; `staging` is not guarded.
(e) *Host-level pieces* (the nftables table, the AppArmor profile, the
network and shadow units, under `/usr/local/lib/quiz-codespace`) are
written by the bootstrap and by a `prod` deploy only, never by a staging
deploy. Like the separate checkout, this prevents accidents (a staging
commit changing what production runs under), not attacks. The switch from
heig-classroom's portal and the operations are
`apps/codespace/deploy/RUNBOOK.md`. The portal holds no GitHub App key
(`FORGE_KIND=none`, root invariant 15).
(f) *Risk accepted by the owner (2026-10-07):* the staging key deploys
every commit of `main` before approval and runs that commit's scripts as
root on the VM that hosts the production runner and portal, and the
staging portal mounts the rootful Podman socket, which is root-equivalent.
The app VM separates staging by account; this VM cannot, short of a
staging engine of its own.

**Amended (2026-10-08, M6-05 part 2): capacity and backups of the engine
VM.** Scope: the addendum's resize and slices; the backups this VM lacked.
(a) No resize while the workspace is test-only (owner); a real class needs it.
(b) Two slices, `quiz-runner.slice` above `codespace.slice` in CPU and IO
weight, the runner's memory protected, the workspace's capped (values and
sizing: `infra/engine/*.slice`); containers join theirs through
`--cgroup-parent`, an addition to invariant 12's list, set by the quadlets.
(c) Backup, destination A as a stopgap: a root forced command (`restrict`,
`from=`) streams each instance's SQLite `.backup` and volumes; `srv` on the
app VM pulls it daily. No credential travels: env files stay in the vault
(ADR-010), session cookie tokens are blanked in the copy. Accepted limits:
volumes are read live (a repository may need its `shadow.git`), one
provider, the app VM's small disk, a key that reads all workspace data, and
monitoring by hand (not in ADR-055's status). (d) Destination B, restic to
S3 from the engine VM, before a real class. Procedures: `deployment.md` §3.
(e) Part 3: the host's input policy drops by default, in its own table
`inet host` that never flushes the codespace and netavark tables; the first
apply is manual behind a 180 s rollback, later production deploys reload a
changed file behind the same rollback and confirm it only if SSH is still
admitted (`infra/engine/host.nft`, `nft-apply.sh`).

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

## Update 2026-09-25

The application VM is now the Hetzner Cloud VM `portal.heig.chevallier.io`
(CPX12, 1 vCPU, 2 GB + 2 GB swap), shared with heig-classroom and evaluation-tb
as before; `quiz.chevallier.io` is a CNAME to it. The stack lives in
`/srv/quiz` and runs as the `srv` account on rootless Docker, and the CI key is
pinned in `/home/srv/.ssh/authorized_keys` (`DEPLOY_USER=srv`). The runner's
Caddy allowlist names the new address, `128.140.71.35`. The runner VM is
unchanged. The [deployment runbook](../development/deployment.md) holds the current layout.
