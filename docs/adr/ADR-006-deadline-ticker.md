# ADR-006 — Deadlines through a single ticker-sweeper, no scheduled one-shot job

## Status

Accepted (2026-07-03, phase 3).

**Addendum (2026-09-30, ADR-035, the classroom merge):** in Quiz this
record governs the deadlines of evaluations through the ticker
(`apps/api/src/ticker.ts`); with the merge it applies again to what it was
written for, the deadlines of **projects** (classroom's *assignments*).
The project sweeps — deadline application, the definitive freeze at
`deadline + grace` (ADR-012), scheduled publication, the J-1 reminder —
are tasks (`TickTask`, with their `everyMs`) of Quiz's single ticker, not
a second one: they claim and enqueue only, and never call GitHub inside a
tick (invariant 5). The 20 s period of point 1 becomes the task's
`everyMs`. Point 1's "singleton per assignment" does not carry over as
written: in pg-boss 12 a `singletonKey` without `singletonSeconds`
dedupes nothing on a `standard` queue (quiz #273), so the port chooses a
queue policy when it creates the queue. The journal's `visible_from` hint
(ADR-049, addendum, J4) is one more sweep of the same ticker. Accommodations
on project deadlines are D13, settled 2026-10-01: the roster's time bonus
does not apply to a project; a per-repository unlock covers the cases
(F-PROJ-09).

**Addendum (2026-10-02, merge task M3-05a):** as built for projects,
point 1's singleton is a **lease** on the project's row and point 2's
per-repository jobs one job per project settling its repositories four at a
time, each step re-reading the row; a deadline is per repository (D13
amended). The decision is [ADR-064](ADR-064-echeance-des-projets-baux.md).

**Addendum (2026-10-08, issue #555):** the evaluation deadlines the ticker
sweeps gain two cases, with the same rule (server clock, `deadline + 3 s`):
a Live evaluation's optional safety deadline (`manual` timing with a
`closes_at`), and the end of a Scheduled window cutting a per-student limit.
The decision is [ADR-086](ADR-086-planifiee-ou-en-direct.md).

**Addendum (2026-09-30, D10, merge task M2-05):** the ticker now carries
two kinds of periodic work. The clock-bound sweeps above stay `TickTask`s
of the loop, neither configurable nor disableable. The minutes-scale
housekeeping (purges, reminders, and the reconciliations of ADR-011 as
they are ported) are *scheduled tasks*: their period, activation and last
outcome live in `scheduled_tasks`, a tick task claims the due ones in one
conditional UPDATE on the database clock and enqueues them on
`system.task` (spec 05 §5.4, Clock). Point 1's advisory lock is not used: the
claim is the multi-process safety, as for every other sweep.

## Context

The deadline job must start at most 60 s after the due time and apply to 100 repositories in
under 5 min (US-22, NFR-13), survive an outage of any length without double application
(NFR-09), and follow deadline rescheduling (US-08, GH-43). Deadlines are entered in
Europe/Zurich and stored in UTC (C-02).

## Decision

1. A **single ticker** runs every 20 s, protected by a Postgres advisory lock (safe even
   after a `WORKER_MODE` split): it selects the published assignments whose
   `deadline_at <= now()` and `deadline_applied_at IS NULL`, and enqueues a `deadline.apply`
   job (singleton per assignment).
2. `deadline.apply` fans out into per-repository jobs (concurrency 10), each idempotent (it
   re-reads `locked_at` and `bot_commits` before acting); individual failures stay in retry
   without blocking the other repositories.
3. **Freezing** follows the same mechanism: a scan on `frozen_at IS NULL` triggers the
   definitive freeze at `deadline + grace_minutes` (details in ADR-012).
4. The partial indexes `assignments(deadline_at) WHERE state='published' AND
   deadline_applied_at IS NULL` (and its equivalent for freezing) make the scan free.

## Consequences

- Start guaranteed in under 60 s (20 s period, a factor-3 margin).
- **Rescheduling is free**: the ticker re-reads the table, there is no job cancellation to
  handle.
- **Catch-up after an outage is free**: the SQL condition stays true as long as the deadline
  has not been applied; no double application, thanks to `deadline_applied_at` and to the
  idempotency constraints.
- A single code path to test and debug.

## Rejected alternatives

1. **A one-shot job scheduled at `deadline_at`** (`startAfter`, productivity and robustness
   proposals as a latency optimization, backed by a guarantee sweeper): the "belt and
   braces" approach maintains two code paths that can diverge, for zero latency gain against
   a 20 s ticker. The review kept the single mechanism.
2. **External cron (systemd timer)**: it moves the logic out of the application process and
   complicates deployment with no benefit; pg-boss and the in-process ticker cover the need.
