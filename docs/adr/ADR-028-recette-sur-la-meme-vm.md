# ADR-028 — A staging environment on the production VM, and promotion by sha

## Status

Accepted (2026-09-26, asked for by the product owner after the move to
Hetzner).

## Context

Every push to `main` deployed straight to production. Several agents merge to
`main` concurrently (`AGENTS.md`), so the checks of a pull request were the
only barrier between a change and the students — and the checks run on an
empty PGlite database, never on data shaped like production's. A migration
that fails on real rows, a boot that crashes on a real configuration, a flow
that only breaks on real content: all of them were found in production.

The product owner wants an intermediate environment — a real server, reached
at `quiz.dev.chevallier.io`, deployed by CI, holding production's data — where
a change is walked before students see it.

The application VM was moved to Hetzner on 2026-09-25 partly to make room for
this: 1 vCPU, 1.9 GB of RAM, 2 GB of swap. Measured on 2026-09-26, with
heig-classroom, evaluation-tb and quiz running: 953 MB available, 0 swap
used; quiz itself takes 123 MB (app) + 59 MB (PostgreSQL). No container
carries a memory cap.

## Decision

### 1. Staging lives on the production VM

A second checkout, `/srv/quiz-staging`, runs `compose.staging.yml` (compose
project `quiz-staging`, port `127.0.0.1:3003`) behind one more Caddy fragment
(`Caddyfile.staging` → `/etc/caddy/conf.d/quiz-staging.caddy`). Same account
(`srv`), same rootless Docker, same IP and host key.

Staging must never cost production anything, so every staging container is
capped — app 256 MB and 0.5 CPU, PostgreSQL 160 MB and 0.5 CPU, a CPU weight
of 256 against the default 1024 — and the app's V8 heap is capped below the
container's (`--max-old-space-size=192`), so it collects instead of being
killed. Under pressure the kernel starves or kills staging, never a
neighbour. On an exam day staging is stopped.

Staging runs the runner in `stub` by default: it never loads production's
runner during an exam. A staging runner, with a token of its own, can be
added on the code VM when the runner itself is under test.

### 2. Build once, promote the same sha

CI builds one image per commit, tagged with its sha (and `:latest`, for
convenience only). Every push to `main` deploys that sha to staging, then
waits for `/healthz` to answer 200. The `deploy-production` job deploys the
SAME sha — the same image — once a required reviewer approves the
`production` GitHub environment. Only the most recent pending promotion
waits; an older one is cancelled by the concurrency group.

`deploy.sh` receives `<sha> <token>` over the forced-command SSH key, moves
its checkout to that commit, detached, and starts the image tagged with it.
The tag is written to `.env.image`, so that a manual `up -d` restarts the
deployed image rather than whatever `:latest` has become. The runner's
`deploy.sh` does the same, retagging the promoted sha as the `:latest` its
quadlet runs. Rollback is a re-run of an older run's `deploy-production` job.

Staging and production deploys on the VM are serialized by a lock, since they
share one Docker daemon.

### 3. Production's data, not anonymized, behind a login allowlist

`scripts/staging-refresh.sh` restores a production dump (last night's, or
one taken now) into the staging database, copies the question images, and
empties every credential production issued: sessions, launch tickets, API
tokens, OAuth requests and grants. It runs on demand, never on deploy — a
deploy must not wipe a test being prepared. Each refresh is also a restore
test of the production dump.

The data is not anonymized, by the product owner's decision: staging is on
the same VM, under the same account, as the data it copies, so a copy adds no
exposure a compromise of the VM would not already give. Staging is closed
instead: `LOGIN_ALLOWLIST` (addresses and `@domain` entries) is checked in
the OIDC callback before any row is written; the super administrator is
always admitted; empty, the default, admits everyone, as production does.
The vhost sends `X-Robots-Tag: noindex`.

### 4. Staging is production, configured

Staging runs `NODE_ENV=production`, so every refusal of `config.ts` applies
to it: no development login, no PGlite, no development secret. Invariant 3 is
not relaxed for staging. Signing in as a student to walk a flow — for a
person or for an agent — is a feature to build on the launch tickets of
ADR-027 (a delegated session), not a development login turned back on.

## Consequences

- A change reaches students only after it has booted and migrated on
  production-shaped data, and after a person said so.
- Production deploys need an approval click; a hotfix goes through staging
  like anything else (a couple of minutes).
- The VM carries one more app and one more PostgreSQL, about 200 MB when
  idle, hard-capped at 416 MB.
- Rootless Docker applies `cpus`/`cpu_shares` only if systemd delegates the
  `cpu` controller to the user session (deploy.md §8 checks it).
- Staging cannot measure performance: it is capped and shares a vCPU.
- Staging holds real personal data; its access list is part of its
  configuration and is reviewed like a secret.

## Rejected alternatives

- **A second VM.** Better isolation, but another host key, IP, firewall and
  bill for an environment serving one or two people. The measured headroom
  makes it unnecessary; if the VM ever runs short, the first move is the next
  Hetzner size, not a second machine.
- **A staging database rebuilt on every deploy.** It would test every
  migration against fresh data, but erase every test set up by hand.
- **Anonymizing the copy.** Rejected for now (§3); `staging-refresh.sh` is
  the one place it would go.
- **Automatic promotion after the health check.** A green `/healthz` says the
  process boots, not that the change is right, and nothing should reach
  production during an exam without someone choosing it.
- **The development login on staging.** It would need a flag that, set by
  mistake in production, opens every account. Rejected with invariant 3.
