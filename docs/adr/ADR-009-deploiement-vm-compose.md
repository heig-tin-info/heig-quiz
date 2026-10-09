# ADR-009 — Deployment on a single VM, Docker Compose, Caddy, provider and off-site backups

## Status

Accepted (2026-07-03, phase 3). **Amended by ADR-016** (the runner is not in
the application's compose file), **and ADR-028** (a staging environment on the
same VM, promotion by sha); **host moved to Hetzner on 2026-09-25**
(`docs/development/deployment.md` is the current runbook: Caddy runs natively
on the host, backups are Hetzner Backups plus an on-VM `pg_dump`). **Decision 4 is
amended by ADR-055**: `/healthz` stays narrow (database, and coarse words),
and the technical administration screen is the admin's System status.

**Decision 3 is amended (2026-10-09, #235, the product owner's decisions):
the off-site copy is a borg repository on a Hetzner Storage Box, written
append-only from the VM.** One repository (`repokey-blake2`) holds, every
night, the dumps and assets of every service of the application VM (quiz,
heig-classroom, evaluation-tb, the codespace archives); the runbook is
`docs/development/deployment.md` §6, *The off-site copy*; the box's account
and the repository's name are kept out of this repository. Three choices
stand in the place of point 3's object storage:

- **Append-only from the VM.** The box forces the VM's key into
  `borg serve --append-only --restrict-to-repository`: the VM adds
  archives and cannot remove one, and a deletion sent through it is
  recorded but reversible until a compact. That is the property that
  matters against a compromised VM or a rogue deploy.
- **The key and the passphrase are on the VM.** borg's encryption is
  symmetric, so the VM that writes must hold them; #235's criterion "the
  decryption key is not on the VM" is dropped. Why it is acceptable: the
  box only ever sees ciphertext; an attacker on the VM already holds the
  live databases; what the key adds for that attacker is the data deleted
  since (up to the retention), not a new kind of access. An asymmetric
  scheme (`age` to an offline recipient) would keep it off the VM at the
  price of deduplication and of a second tool; it was not chosen. The
  passphrase, the box's full-access key and the exported repository key
  also go to the vault (ADR-010).
- **Prune and compact only from a trusted machine** (the operator's
  workstation, `scripts/offsite-backup/prune.sh`), never from the VM: a
  compact would make a deletion through the append-only key permanent. The
  script refuses to prune when an archive it left at its previous run is
  gone, or when a day after the newest of those, up to yesterday, has no
  archive (unless told the gap is an outage), or when it has no record of a
  previous run. It cannot see a deletion of an archive whose day still has
  another one, nor of today's. Retention: 7 daily, 8 weekly, 12 monthly.

The box is in Helsinki: outside Switzerland, like the VM itself since the
move to Hetzner (2026-09-25), against rejected alternative 1; it holds only
ciphertext. The Hetzner provider backup of the whole VM and the on-VM dumps
stay as they were. The `offsite` check of ADR-055 watches the copy.

Amended 2026-10-09: the hosting facts are rewritten to the real state (title,
Context, decisions 1 to 3, Consequences, rejected alternative 1): a Hetzner
VM in Europe, Caddy native on the host, Hetzner Backups beside the on-VM
dumps and the off-site copy. Hosting in Switzerland (Switch Cloud) remains an
option, which the product owner will decide on within 6 to 12 months (open
question 56 of `docs/spec/06-questions-ouvertes.md`).

Historical Quiz scope before the classroom merge excluded GitHub reconciliation
and its metrics. Since 2026-09-30, [ADR-011](ADR-011-reconciliation-par-les-handlers.md) is imported through
[ADR-035](ADR-035-fusion-de-classroom.md). Read those records for reconciliation and [ADR-055](ADR-055-etat-du-systeme.md)
for current observability; the original deployment below is historical where
the Status amendments change it.

## Context

The availability target is 99 % during semesters (NFR-08), with an external probe on
`/healthz`, a daily backup with RPO 24 h and RTO 4 h tested every semester (NFR-16). Personal
data of Swiss students: the Swiss data protection act applies (NFR-07, H11), and the
specification asks for a server in Europe (N-DATA-01). The operator is a teacher.

## Decision

1. **One application VM at Hetzner, in Europe**, shared with heig-classroom and
   evaluation-tb (its size and accounts: `docs/development/deployment.md`, *The two
   machines*). **Docker Compose** (the service account's rootless Docker) runs three
   services: `app` (a single image, front end included), `postgres` (local volume, not
   exposed) and `backup`. **Caddy** is the host's native package, shared with the
   neighbours: automatic TLS, HSTS, the only exposed ports, one fragment per service.
   Webhooks are a route of the monolith behind Caddy; in development, `smee.io` or
   `cloudflared tunnel`. The code runner is on another VM (ADR-016).
2. Deployment from CI: images built on GitHub Actions and pulled from GHCR, tagged by
   commit sha, deployed through a forced command (`deploy.sh`), never built on the VM;
   migrations at startup (under a lock); rollback by redeploying an earlier sha
   (ADR-028; runbook §5).
3. **Backups**: a daily provider backup of the whole VM (Hetzner Backups), a daily
   `pg_dump -Fc` by the compose `backup` service kept 30 days on the VM, and the off-site
   copy of the Status (a borg repository on a Hetzner Storage Box, append-only from the
   VM). A **timed** restore test once per semester.
4. **Requirements-driven observability**: `/healthz` (DB, pg-boss, clock) probed every 60 s;
   a Prometheus `/metrics` endpoint exposing the age of the oldest unprocessed webhook, the
   queue lag, dead-lettered jobs, the remaining GitHub quota and the ticker lag; a minimal
   technical administration screen (dead letters with replay).

## Consequences

- Three containers, one compose file, one Caddy fragment on the host: the whole deployment
  can be rebuilt from scratch in under an hour.
- Restoring follows the runbook: fresh VM, infrastructure repository, secrets from the vault
  (ADR-010), `pg_restore`, DNS, GH-62 reconciliation — the cron jobs absorb the lost window
  (ADR-011). RTO 4 h validated by the semester test.
- Data and backups are in Europe (the VM at Hetzner; the off-site copy in Helsinki, as
  ciphertext), which N-DATA-01 asks for. Hosting in Switzerland (Switch Cloud) remains an
  option the product owner will decide on within 6 to 12 months (open question 56).

## Rejected alternatives

1. **A foreign cloud host or backup storage outside Switzerland** (Backblaze, cited by the
   robustness proposal): defensible when encrypted, but it opens an avoidable question of
   cross-border transfer — institutional storage removes it. *No longer rejected: the
   platform moved to Hetzner, in Europe, on 2026-09-25, and its off-site copy is encrypted
   in Helsinki; Swiss hosting is open question 56.*
2. **Kubernetes or a managed PaaS**: disproportionate operational capacity, external
   dependencies and recurring costs with no gain on the NFRs.
3. **A minimal probe and minimal metrics only** (initial simplicity proposal): the review
   kept the observability from the robustness proposal — without it, diagnosing a deadline
   burst would mean raw SQL in the pg-boss tables.
