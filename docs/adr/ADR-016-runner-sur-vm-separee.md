# ADR-016 — The code runner on the codespace VM, behind Caddy, with a shared token

## Status

Accepted (2026-09-21, first production deployment).

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
   to `127.0.0.1:3200`, the rootful socket as its only mount, read-only root, no
   capability. The sandbox containers it starts are unchanged. The language images
   are built on that VM from `apps/runner/images/`, its only supply chain.
3. **The link between the two is HTTPS with two gates.** The code VM's Caddy serves
   `quiz-runner.chevallier.io` (fragment `apps/runner/deploy/Caddyfile`) and answers
   403 to any source address but the classroom VM's. The runner itself requires
   `Authorization: Bearer <RUNNER_TOKEN>` on both routes, compared in constant time;
   the API sends it on every call. Production refuses to start without the token on
   either side (`config.ts` of both). `/health` is guarded too, so a wrong token is a
   runner reported `down` by `/healthz`, not one that says `up` and refuses every run.
4. **One CI key, two forced commands.** The `deploy` job SSHes to both VMs with the
   same key, pinned to `/opt/quiz/deploy.sh` on one and `/opt/quiz-runner/deploy.sh`
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
- Two DNS records (`quiz`, `quiz-runner`), two VMs to keep patched, one more
  Let's Encrypt certificate. The runner being down degrades to decision D14: a
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
3. **The runner on `code.chevallier.io:8443`, no new DNS name**: reuses the existing
   certificate but needs a firewall change and a port to remember; a name costs one
   record.
4. **Plain HTTP on a firewalled port**: student code and outputs in clear across the
   internet, for no saving.
