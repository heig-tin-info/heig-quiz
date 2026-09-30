# ADR-055 — The system status: one registry of health checks, a narrow `/healthz`, a backup report

## Status

Accepted (2026-09-30, decisions of the product owner). Delivers N-OPS-03
(the internal health page) and the "active real-time connections" of
N-OPS-02, as the requirement F-ADMIN-07. Built on the `system` module and
the scheduled tasks of merge task M2-05 (D10). Amends
[ADR-009](ADR-009-deploiement-vm-compose.md) §4 (the observability it
announced) and completes [ADR-028](ADR-028-recette-sur-la-meme-vm.md) (the
deploy gate reads `/healthz`, whose contract this ADR fixes).

Delivered with `@quiz/domain/health` (the thresholds),
`apps/api/src/modules/system/health.ts` (the registry), the route
`GET /app/api/admin/system`, the `SystemStatus` and `HealthResponse`
schemas of `@quiz/contracts`, the "System status" tab of the Administration
page, and the backup report written by the `backup` service of
`compose.prod.yml`.

## Context

The operator is one teacher. Before an exam, and when something feels
wrong, the question is always the same: **can I run an exam now, and does
anything need me?** Until now the answer took an SSH session: `docker
compose logs`, `df -h`, `ls backups/`, a `psql` on the pgboss schema. And
the one thing that must never stop — the ticker that closes attempts at
`deadline + 3 s` (invariant 5) — had no symptom anywhere but a student still
typing after the end.

`/healthz` existed, answered 503 only when the database was down, and was
already read by three parties: the container `HEALTHCHECK`, the deploy gate
of ADR-028 (`up -d --wait`, and the CI's wait on staging) and an external
uptime probe. It is public.

The logical dumps live in `/srv/quiz/backups`, 30 days of them, next to the
database they protect. They hold data that a deletion (N-DATA-03) removed
from the live database up to 30 days ago.

## Decision

### 1. One registry of checks, thresholds in the domain

A check is a named async function (`HealthCheck { key, section, run }`)
returning `{ status: ok | warn | fail | unknown, value?, cause?, details? }`.
The keys are the closed list `SYSTEM_CHECK_KEYS` of `@quiz/contracts`, and
the causes the closed list `CHECK_CAUSES`, so the screen names every check
and words every cause in both languages or does not compile. Values are
typed (`count`, `duration`, `bytes`, `share`, `at`) and formatted by the
client in its locale. A check reports counts and sizes, **never who**: no
student, no title, no log line (the page is not a log viewer; logs hold
personal data).

The thresholds that turn a measure into a verdict are pure functions of
`@quiz/domain/health` (invariant 8): the ticker is dead past 10 s (or three
periods); an attempt or an evaluation still open **a minute** past the
moment the ticker should have closed it fails; a disk warns under 15 % free
and fails under 5 %; the last dump warns after 26 h and fails after 50 h; a
scheduled task warns when its last run failed or it has had no success for
two periods; `SELECT 1` warns past 250 ms; connections warn at 80 % and
fail at 95 % of `max_connections`; a queue warns on a failure in the last
day or a job ready and waiting for ten minutes.

`unknown` is not a verdict: it is a check that cannot measure here — no
ticker in a `WORKER_MODE=web` process, pg-boss statistics on the in-process
development queue, no backup report configured. It never counts as a
failure.

The checks, in two sections:

- **Live exam readiness**: the ticker's lag (the time since its last
  completed pass, kept in memory by `startTicker`); the **outcome checks**,
  which catch a dead clock whatever the process layout — attempts still
  `in_progress` past their own deadline plus the grace plus a minute, and
  evaluations still `running` past the moment step 4 closes them; the
  scheduled tasks; pg-boss per queue (waiting, failed in 24 h, oldest wait);
  the runner (F-ADMIN-02's reachability); the live evaluations and the open
  SSE streams, as information.
- **Data and storage**: the database's response time, its size and its five
  largest tables, the connections in use; the free disk under the question
  images and under the backup report; the last backup.

The outcome checks do not re-derive "overdue". `live/ticker.ts` extracts
the predicates of steps 1 and 4 (`dueAttempts`, `dueToClose`), and
`overdueLiveWork` asks them about `now − 60 s`. An attempt's `deadline_at`
already holds its accommodation, its extensions, its reopening and every
pause shift (ADR-025, F-ORG-07), and a paused evaluation is excluded exactly
as the ticker excludes it; so the check cannot disagree with the ticker
about what is due, only notice that it did not run.

A third section, **Deployment**, is identity rather than a check: the
commit (the Dockerfile now passes `COMMIT_SHA`/`COMMIT_DATE` to the API's
runtime, not only to the SPA's build), the last migration applied (its tag
in drizzle's journal), the process start, Node's version, `WORKER_MODE`,
`NODE_ENV` and the public host.

### 2. `/healthz` stays narrow

`/healthz` is public and the deploy gate reads its status code. It keeps
**503 only when the database is down**, exactly as before. It gains coarse
words, computed by the registry's checks that touch no table (the ticker,
the disk, the backup report, the runner's `/health` — memory, two small
file reads and one HTTP call per probe), run side by side and bounded at
**1 s all together**: the container healthcheck gives the route 5 s and
the deploy gates on it. A check past the bound reads as its worst word.
`checks.ticker: up | stale | none`, `checks.disk: ok | low | unknown`,
`checks.backup: ok | stale | unknown`, and one aggregate,
`attention: true | false` — true when the ticker is stale, the disk low,
the backup stale, failed or unreadable, or a configured runner down. The
rule lives in one place, `coarseHealth`. **No path, no size, no name, no
number** (the uptime aside) is added: the details are on the admin
endpoint only.

### 3. The admin endpoint runs the registry on demand

`GET /app/api/admin/system` (the admin guard, schema `SystemStatus`) runs
every check side by side, each bounded at 3 s (a hung check is `unknown`,
cause `check.failed`, and never holds the others). The result is cached for
20 s per process and shared by concurrent callers; `?fresh=1` — the
screen's Refresh — bypasses it. The
screen polls every 30 s while visible. On the production VM (1 vCPU) a full
run is a handful of small queries.

The pg-boss statistics read the `pgboss` schema directly (no pg-boss API
counts failures over a window); a job's wait runs from its `start_after`.
That SQL cannot run on PGlite, so `health.pg.test.ts` runs it against a
real PostgreSQL when `TEST_PG_URL` is set. Should a pg-boss upgrade reshape
`pgboss.job`, the query throws and the check degrades to `unknown`
(`check.failed`); nothing else is affected.

### 4. The backup service writes a report; the app never reads a dump

The dumps are **not** mounted into the application container: the
internet-facing process must not be able to read a file holding data
deleted up to 30 days ago. Instead the `backup` service writes, after each
dump, a one-line JSON report — `finished_at`, `ok`, `exit_code`, `file`,
`size_bytes` — into a small directory of its own, `./backup-status`,
through a temporary file and a rename. That directory alone is mounted
read-only into `app`, whose `BACKUP_STATUS_FILE` points at the report.
Without the variable (development, staging, which has no backup service)
the check is `unknown`, "not configured"; with it and no file yet, `warn`.

The page says, on the backup line, that the copy is **local only and no
off-site copy is configured**: open question 10 of
`docs/spec/06-questions-ouvertes.md` stays open, and this ADR does not
settle it.

### 5. The alarm: an external probe now, mail next

The primary alarm is the product owner's **external uptime probe**,
alerting on a non-200 and on a body without `"attention":false`
(`docs/development/deployment.md` §7): it also sees what the process cannot
report about itself (a VM down, a crash loop, a certificate or DNS gone
wrong). The next step adds a `health.checks` task to the scheduled catalog
(D10) that runs the same `runChecks` every five minutes, keeps the
transitions and mails the administrators through a new notification kind
(ADR-030); nothing of it is built here.

## Consequences

- The operator answers "can I run an exam now?" from the Administration
  page, in both languages, without SSH, and a dead ticker has a symptom
  within a minute, whether the process running it is this one or not.
- `/healthz` still means "the process is up and its database answers" for
  every party that reads its status; the external probe gets one more,
  coarse, signal from its body.
- The backup service's command grew a report, and production needs one more
  directory, `./backup-status` (deployment.md §6). Staging reports
  "not configured", which is true.
- Every new check is a function in `health.ts`, a key in
  `SYSTEM_CHECK_KEYS`, its causes in `CHECK_CAUSES`, a threshold in the
  domain if it judges, and its two names in the web's dictionaries.
- The pg-boss statistics read the `pgboss` schema directly (§3); a pg-boss
  upgrade that reshapes `pgboss.job` turns that one check `unknown`
  (`check.failed`), nothing else.

## Alternatives considered

1. **Mount `./backups` read-only into `app` and list it.** Simple, and the
   file sizes and dates would be exact. Rejected: the internet-facing
   process would hold 30 days of dumps, including data deleted under
   N-DATA-03; a report of a few bytes gives the same answer.
2. **Detailed values in `/healthz`.** One endpoint for everything, and the
   probe could read the numbers. Rejected: the route is public, and paths,
   sizes and counts describe the installation to anyone.
3. **Make `/healthz` answer 503 on a stale ticker or a full disk.** The
   probe would need no keyword. Rejected: the deploy gate and the container
   healthcheck read that status, and a restart or a refused deploy is the
   wrong answer to a disk filling up or a backup a day late.
4. **Grafana, Prometheus and a log viewer.** The metrics endpoint exists
   for a Prometheus that may come; a dashboard of charts answers "what
   happened?", not "can I run an exam now?", and a log viewer would put
   personal data on a screen. Rejected for this page.
5. **Recompute on every request, no cache.** Simpler, but two open admin
   tabs polling would double the load at the worst moment; 20 s of staleness
   costs nothing for a page of this kind, and Refresh bypasses it.
