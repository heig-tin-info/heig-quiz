# ADR-001 — Modular monolith, single process, optional `WORKER_MODE` split

## Status

Accepted (2026-07-03, inherited from heig-classroom). Amended for Quiz on
2026-10-03 against `apps/api/src/{app,server,config,events}.ts`: inherited
details the code never adopted are withdrawn, and the decision below is the one
in force.
The [inherited record](history/ADR-001-monolithe-modulaire.md) keeps the original module names and alternatives.

## Context

A small teaching platform operated by one person needs simple deployment
and recovery. Bursts are handled by durable jobs rather than separate services.

## Decision

1. One Fastify application serves the SPA, `/app/api`, GitHub webhooks and
   SSE, and starts jobs and the ticker. Bearer tokens use the same API as
   sessions (ADR-022), not the inherited `/api/v1` surface.
2. Modules communicate through services. `packages/domain` contains pure
   rules; the current layout is in [the repository map](../development/repository.md).
3. `WORKER_MODE` selects `all`, `web` or `worker` (`config.ts`, `server.ts`,
   `app.ts`). A deployed process split still needs the planned Postgres
   event relay: `events.ts` currently uses an in-process emitter. Do not
   interpret the inherited “without any code change” as a working cross-process bus.
4. The application is a single point of failure, accepted for operational
   simplicity. Restart, persisted jobs and database-clock sweeps recover work.
   Question execution is isolated on its own service/VM (ADR-016).

## Consequences

One application deployment and no distributed cache. A blocked process can
affect HTTP, jobs and deadlines together; monitor it through ADR-055. GitHub
installation tokens remain in memory only (ADR-010).

## Rejected alternatives

Microservices, Kubernetes and separate process roles from the start add
operational work without a justified load requirement. The inherited record
retains their original comparison; process splitting remains an option,
not a claim that distributed operation is already implemented.
