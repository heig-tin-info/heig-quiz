# ADR-004 — pg-boss job queue on Postgres

## Status

Accepted (2026-07-03, inherited from heig-classroom). Amended 2026-10-03: the
durable Postgres queue remains; the inherited singleton keys, dead-letter replay
screen and queue metrics, never built in Quiz, are withdrawn. Quiz's queue policies are in `apps/api/src/jobs.ts` and each
module's job registration; the [inherited record](history/ADR-004-jobs-pg-boss.md) is not their configuration.

## Context

Grading, external notifications and GitHub work must outlive an HTTP request
and, in production, survive a process restart without a second stateful service.

## Decision

1. Use pg-boss on PostgreSQL. `jobs.ts` exposes the shared `JobQueue` interface;
   the manifest/lockfile own its version. PGlite development uses an in-process,
   non-durable adapter; production refuses PGlite.
2. Register concurrency and retry policy per queue. There is no universal
   ten-worker/five-retry rule: grading, LLM, notifications, scheduled tasks and
   project leases have different failure semantics.
3. Do not assume `singletonKey` deduplicates a standard queue. Quiz does not
   expose it in `SendOptions`; idempotent handlers, database claims and leases
   own duplicate protection. See ADR-006/011/064 and the queue's owner.
4. Use [ADR-055](ADR-055-etat-du-systeme.md) and the deployment runbook for
   monitoring. The inherited generic dead-letter replay screen is not an
   implemented operator contract.

## Consequences

One database backup covers durable jobs and business data. Failure recovery
is part of each handler: for example `grading.llm` has no queue retry
(ADR-063), whereas notification delivery retries with backoff (ADR-030).
The development adapter is not evidence of production durability or concurrency.

## Rejected alternatives

Redis/BullMQ or a dedicated broker add another service to operate. System
cron and hand-built queue tables would recreate persistence, retries and
worker coordination. The inherited record retains the original trade-offs.
