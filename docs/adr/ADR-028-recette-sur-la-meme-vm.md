# ADR-028 — A staging environment on the production VM, and promotion by sha

## Status

Accepted (2026-09-26, asked for by the product owner after the move to
Hetzner). Amended 2026-09-28: staging runs as its own account (see *Update
2026-09-28*). Amended 2026-10-11 (security audit M8, M9, L17): the copy is
pseudonymized and the inbox emptied after each refresh, which replaces the
"not anonymized" decision of §3; the deploys pull the image by digest
(see *Update 2026-10-11*).

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
  the one place it would go. (Adopted as a pseudonymization on 2026-10-11.)
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

The 2026-10 security audit (M9) asked §3 again: main's unapproved code ran
against production's real names, addresses and grades, and the last full
export stayed in `/srv/staging-inbox` until the next one. Since the account
split of 2026-09-28 the premise of §3 (same account, so no added exposure)
no longer holds either. §3 changes as follows; the login allowlist stays.

- **The copy is pseudonymized.** `staging-refresh.sh` runs
  `scripts/staging-pseudonymize.sql` on the restored copy, before the scrub
  and before the application starts on it. Who people are is replaced, not
  what they did: names, addresses, edu-ID and OIDC subjects, GitHub and
  Teams identities become deterministic fakes (`student-12@example.invalid`),
  and the free text that names people beside the content (IdP claims,
  avatars, roster notes, audit and webhook payloads, notifications, guest
  pseudonyms) is emptied. Grades, answers and content stay, with the free
  text people wrote in them. The trigger that keeps `audit_log` append-only
  (ADR-003 §5) is lifted for that rewrite, inside its transaction, on the
  copy only: it guards production's record, and staging's copy is not it.
- **A keep list** leaves the accounts that must work on staging untouched:
  `STAGING_KEEP_EMAILS`, the super administrator and the full addresses of
  `LOGIN_ALLOWLIST`. Anyone else who signs in on staging gets a new, empty
  account: a login finds its account by `oidc_sub`, which the fakes replace.
- **One exception**: the refresh of the heig-classroom cutover rehearsal
  keeps the real identities (`--keep-identities`), because the import
  matches people by their addresses and edu-ID identifiers; that copy is
  deleted the same day (docs/merge/10-cutover-runbook.md §5.1).
- **The export does not outlive the refresh.** A successful refresh empties
  the inbox's files (group-writable for that; the directory stays read-only
  to `srvstg`); a failed one keeps them, and says so, for a retry.

The scrub (§3) also empties the secrets kept in rows (audit L17): the
encrypted LLM key, kiosk station credentials and pairing codes, poll
guests' tokens, Teams link tokens. Both scripts are tested against the real
migrations (`apps/api/src/stagingScrub.db.test.ts`), by markers searched for
in every table.

This concerns the staging COPY only. Production keeps its data as it is:
pseudonymizing production's accounts is not a Quiz requirement (ADR-003's
2026-10-09 amendment, issue #681), and nothing here changes that.

§2 (build once, promote the same sha) now pins the bytes as well (audit M8):
the CI's `image` job publishes each image's digest, and the deploys pull
`<image>:<sha>@sha256:<digest>`, which a tag moved since the build cannot
redirect; `.env.image` keeps both. Third-party actions are pinned by commit
and the image is built without a shared layer cache. The procedure, the
switch-on gate and the environment settings are in
[deployment.md §4](../development/deployment.md#4-continuous-deployment).
