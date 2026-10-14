# ADR-028 — A staging environment on the production VM, and promotion by sha

## Status

Accepted (2026-09-26, asked for by the product owner after the move to
Hetzner). Amended 2026-09-28: staging runs as its own account (see *Update
2026-09-28*). Amended 2026-10-11 (security audit M8, M9, L17): the copy is
pseudonymized before it leaves production, which replaces the "not
anonymized" decision of §3; the deploys pull the image by digest (see
*Update 2026-10-11*). Amended 2026-10-14 by
[ADR-111](ADR-111-admission-a-la-connexion.md): §3's allowlist is now one of
two checks at the door, beside login admission (`LOGIN_DOMAINS`), and a
refusal is a page rather than a JSON `403`.

Note (2026-10-06, M2-06, [ADR-035](ADR-035-fusion-de-classroom.md)): the
refresh of §3 also forgets every GitHub installation, archives every
project, closes the copied webhook deliveries and drops the queued jobs
(`scripts/staging-scrub.sql`), and staging holds its own GitHub App, on a
test organization, never on an organization where production holds real
work, and never production's credentials (N-SEC-18;
[Quiz's GitHub App](../development/github-app.md)).

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
(`srv`), same rootless Docker, same IP and host key. (Superseded on
2026-09-28: staging moved to its own account, `srvstg`, with its own rootless
Docker, in `/home/srvstg/quiz-staging`; see the update below.)

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
waits: the `prod-deploy` group cancels in progress, because a job waiting
for approval already holds the group, and an unapproved promotion would
otherwise block every later one with no Review button (2026-09-29). A push
landing during a running production deploy therefore cancels it, and the
newer promotion deploys instead.

`deploy.sh` receives `<sha> <token>` over the forced-command SSH key, moves
its checkout to that commit, detached, and starts the image tagged with it.
The tag is written to `.env.image`, so that a manual `up -d` restarts the
deployed image rather than whatever `:latest` has become. The runner's
`deploy.sh` does the same, retagging the promoted sha as the `:latest` its
quadlet runs. Rollback is a re-run of an older run's `deploy-production` job.

Staging and production deploys on the VM are serialized by a lock, since they
share one Docker daemon. (Since 2026-09-28 they no longer do; the lock is per
account.)

### 3. Production's data, not anonymized, behind a login allowlist

`scripts/staging-refresh.sh` restores a production dump (since 2026-09-28,
the one `scripts/staging-export.sh` pushed into `/srv/staging-inbox`) into
the staging database, copies the question images, and
empties every credential production issued: sessions, launch tickets, API
tokens, OAuth requests and grants. It runs on demand, never on deploy — a
deploy must not wipe a test being prepared. Each refresh is also a restore
test of the production dump.

The data is not anonymized, by the product owner's decision: staging is on
the same VM, under the same account, as the data it copies, so a copy adds no
exposure a compromise of the VM would not already give. (The account is no
longer the same since 2026-09-28; the decision stood until 2026-10-11, when
the copy became pseudonymized: see *Update 2026-10-11*.) Staging is closed
instead: `LOGIN_ALLOWLIST` (addresses and `@domain` entries) is checked in
the OIDC callback before any row is written; the super administrator is
always admitted; empty, the default, admits everyone, as production does.
(Since 2026-10-14, [ADR-111](ADR-111-admission-a-la-connexion.md) §4: empty,
it admits everyone that login admission admits — everyone while
`LOGIN_DOMAINS` is empty too. Both are checked before any write; the super
administrator passes both; a refusal lands on `/sign-in/refused?reason=restricted`.)
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
  `cpu` controller to the user session (the deployment runbook, §8, checks it).
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
  the one place it would go. (Adopted as a pseudonymization on 2026-10-11,
  at the export rather than the refresh.)
- **Automatic promotion after the health check.** A green `/healthz` says the
  process boots, not that the change is right, and nothing should reach
  production during an exam without someone choosing it.
- **The development login on staging.** It would need a flag that, set by
  mistake in production, opens every account. Rejected with invariant 3.

## Update 2026-09-28

Staging runs every commit of `main` before anyone approves it, and it ran as
`srv`, the account that owns production's secrets, volumes and nightly dumps
(and heig-classroom's and evaluation-tb's). A commit that misbehaved on
staging could read or change all of them. Staging therefore moved to an
account of its own:

- `srvstg`, with its own rootless Docker (lingering enabled), checkout
  `/home/srvstg/quiz-staging`, still port `127.0.0.1:3003` and the same Caddy
  fragment, which `srv` installs; staging cannot write `/etc/caddy/conf.d/`.
- `/srv/quiz`, `/srv/heig-classroom` and `/srv/evaluation-tb` are
  `chmod o-rwx`: they were world-readable, production dumps included.
- The data travels one way. As `srv`, `scripts/staging-export.sh` writes a
  fresh `quiz.dump` and `assets.tar` into `/srv/staging-inbox` (owner `srv`,
  group `srvstg`, mode 2750); as `srvstg`, `scripts/staging-refresh.sh`
  restores them. Staging no longer reads production's directory, nor reaches
  it through a container.
- The CI connects as `vars.STAGING_DEPLOY_USER` (`srvstg`) with
  `STAGING_DEPLOY_SSH_KEY`, a secret of the `staging` environment; the
  production key is a secret of the `production` environment. Neither is a
  repository secret any more.
- Staging and production no longer share a Docker daemon or an image store.

The copy is still not anonymized (§3 stands, by the product owner's
decision; replaced on 2026-10-11, see below): staging stays closed by
`LOGIN_ALLOWLIST`. Staging still uses
production's edu-ID client and key, copied once by root; registering a
separate client with its own key is the follow-up that leaves `srvstg`
holding nothing of production's.

## Update 2026-10-11

§3's "not anonymized" decision is replaced (security audit M9): staging runs
main's unapproved code, and since the account split of 2026-09-28 its
premise (same account, no added exposure) no longer held. The copy is now
**pseudonymized on production's side, before it reaches the inbox**:
`staging-export.sh` copies production into a scratch database of
production's PostgreSQL, rewrites who people are there
(`scripts/staging-pseudonymize.sql`, whose header lists what is replaced
and what is kept), dumps that copy alone and drops it. Pseudonymizing the
restored copy on staging instead was rejected: the originals would survive
in its dead tuples and WAL, readable by that unapproved code. Grades,
answers and content stay real; the login allowlist stays. A keep list
(`STAGING_KEEP_EMAILS` in `.env.prod`) leaves the testers' accounts as they
are; anyone else who signs in on staging gets a new, empty account. The
`audit_log` trigger (ADR-003 §5) is lifted for that rewrite, on the scratch
copy only. One exception, `--keep-identities`, serves the heig-classroom
cutover rehearsal, whose copies are deleted the same day. The scrub also
empties the secrets kept in rows (audit L17). This concerns the staging copy
only: pseudonymizing production's accounts is still not a requirement
(ADR-003, #681).

§2 now pins the bytes too (audit M8): the deploys pull
`<image>:<sha>@sha256:<digest>`, the digest the CI's `image` job pushed
([deployment.md §4](../development/deployment.md#4-continuous-deployment)).
