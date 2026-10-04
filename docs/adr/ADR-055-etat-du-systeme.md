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
`compose.prod.yml`. §5's mail followed (2026-09-30, branch
`ops/health-alerts`): `@quiz/domain/healthAlert`, `modules/system/alerts.ts`,
the table `health_check_states` (migration `health_check_states`) and the
notification kind `system_alert`
(ADR-030, addendum of 2026-09-30).
Amended the same day (branch `ops/health-services`) by §6 (the external
services, and the administrator's test e-mail) and §7 (the HTTP metrics of
N-OPS-02): `apps/api/src/serviceHealth.ts`, `apps/api/src/httpMetrics.ts`,
`serviceStatus` and `serverErrorsStatus` of `@quiz/domain`, the route
`POST /app/api/admin/system/test-mail` (`TestMailResult`) and the audit
action `system.test_mail`. No migration.

Extended by [ADR-058](ADR-058-passerelle-llm.md) §7: LLM health reads gateway state and the
`llm.budget` check; it does not make a provider call.

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

### 5. The alarm: an external probe first, a mail second

The primary alarm is the product owner's **external uptime probe**,
alerting on a non-200 and on a body without `"attention":false`
(`docs/development/deployment.md` §7): it also sees what the process cannot
report about itself (a VM down, a crash loop, a certificate or DNS gone
wrong).

The secondary alarm is the application's own. A `health.checks` task in
the scheduled catalog (D10, every five minutes by default) runs the same
`runChecks` and keeps, per check, what a transition needs — the status of
the last run, since when and for how many runs it holds, the last notice
sent — in `health_check_states`, a table of the `system` module, so a
restart or another process sees the same streak. The rule is pure,
`nextCheckState` of `@quiz/domain`:

- **alert** once a check has been `fail` on **two consecutive runs**: one
  slow run, one restart, one blip of the runner is not news;
- **recovery** once it is `ok` again after an alert, and only then: a
  failure nobody was told about recovers silently;
- a **reminder** when it is still failing a day after the last notice;
- nothing on `warn` (the page shows it; a mail per late dump would teach
  the reader to ignore the mail) and nothing on `unknown`, which is not a
  verdict; never the same notice twice while nothing changed.

The notices of one run are grouped by kind (failing, still failing,
recovered) into one notification each, of the kind `system_alert`, sent
through `notifyMany` to every non-anonymized account whose role is admin
(ADR-030, addendum of 2026-09-30): the bell, and an e-mail by default,
never Teams. It names the checks, in the recipient's language, and the
platform's host, so production and staging cannot be confused, and links to
the System status, where their causes and measures are: the mail says what
to look at, the page says why. Nothing in it is about a person.
The states are stored before the notifications are sent: a notice is sent
at most once, and a send that fails is the task's error on the scheduled
tasks screen, not a retry.

The page shows, under a failing check, when the task first saw it fail
(`SystemCheck.failingSince`).

This alarm shares the process's fate: the task runs on the ticker's claim
and the mail needs the job queue, so a dead VM, a crash loop, a ticker dead
in every process or a queue down silences it. That is why it is second.

### 6. The external services, judged from real traffic

A third section of checks, **External services**, through the same
registry: `service.mail` (Scaleway TEM), `service.signin` (the OIDC
callback's exchange with the identity provider), `service.teams`,
`service.llm` and `service.github` (the App's installation-token fetch).
Nothing is probed: each is judged from the calls the process already makes.

**Recording.** Each transport has one call site — the mailer's `send`, the
Teams client's `notify`, the LLM service `createLlm` returns,
`installationClient`, the callback's `completeLogin` — and it goes through
one helper, `tracked(name, run)` of `serviceHealth.ts`, which keeps in
memory, per process, the last success, the last failure, its CLASS and the
failures in a row since the last success. The class comes from a closed
vocabulary (`timeout`, a registered OAuth code such as `invalid_grant` —
openid-client's `.error`, which for the callback comes from the browser's
query string, so anything unregistered is `oauth_error` —, `http_<status>`,
`network_<code>`, `error`): never a message, which may echo an address, and
never a body. Chosen over the existing tables because none holds it: a mail
delivery is a pg-boss job whose completion says nothing kept past a day,
and the audit log has the logins but not the refused exchanges. In memory
costs no migration and no write on a hot path, and "is the provider
answering us now?" is a question about the process that calls it. What it
costs: a restart forgets it (`unknown` until the next call), and in
`WORKER_MODE=web` the web process never calls the mailer, Teams nor the
LLM, so those rows read `unknown` there (production runs `all`).

A refusal about one recipient is not the service failing: a permanent
Teams refusal (the app not installed for them) counts as an answer. A
missing login state (a stale browser tab), the staging allowlist and
`access_denied` (the person cancelling at the provider) are not the
provider's failing and do not count.

**Verdict.** `serviceStatus` of `@quiz/domain`: `unknown` when never used
since the start; `ok` when the last call succeeded; `fail` when the calls
have kept failing for more than half an hour since the first failure, with
at least two failures (three for sign-in, where a code used twice is the
person's doing); `warn` short of that. A service that is not configured —
no Scaleway credentials (`mail.dry_run`), no Teams application,
`LLM_PROVIDER=none`, no GitHub App — is `unknown`, never a failure; so is
sign-in in development, where the persona picker never calls the provider
(`service.unused`). The services are the closed list `SERVICE_NAMES` of
`@quiz/domain`, from which the check keys `service.<name>` and the
registry's rows derive; the policy is one default with an override per
service (`servicePolicy`). A `fail` feeds the
`health.checks` alerts of §5 like any check; the mail about a failing mail
may itself not arrive, which the page and the external probe cover.

**The test e-mail.** The e-mail row carries a secondary action, "Send me a
test e-mail": `POST /app/api/admin/system/test-mail` (the admin guard)
renders a short en/fr message in the caller's language and sends it to the
caller through the mailer alone — no notification row, no preference, no
queue, and no notification-settings footer, since no preference chose it —
and answers `sent`, `dry_run` or `error` with its class. One per minute per
admin, through the preview's in-memory `Budget` (now `budget.ts`, shared;
a guard against a double click, not a quota), 429 `rate_limited`
otherwise; an account without an address gets 409 `no_email`; audited `system.test_mail` with the outcome,
never the address.

### 7. The HTTP metrics (N-OPS-02)

A hook registered on the root instance before any route feeds
`quiz_http_requests_total{method, route, status}` and
`quiz_http_request_duration_seconds{method, route}` (buckets 25 ms to 10 s)
on `/metrics`. `route` is Fastify's route template (`routeOptions.url`),
`unmatched` when no route matched; never the URL, which carries ids and,
for some routes, one-time secrets. `status` is the class (`2xx`…`5xx`).

The same hook keeps, per process, the 5xx of the last 24 hours in hourly
buckets by route template; the **Server errors (24 h)** check of the live
section shows their count and the three templates that answered most of
them, and warns from five (`serverErrorsStatus`), never fails: an error
page is a reason to read the logs, not an alarm. No log line, no URL, no
user reaches the page.

The per-process values the checks read (the ticker's last pass, this
window) are kept by `perApp`, which the admin routes' plugin instance —
a child of the root — reaches through its prototype; a plain `WeakMap` on
the root missed it, and the ticker's row read "not in this process" on the
page of a process that ran it.

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
- A new check also needs its name in the mail's dictionary (`templates.ts`,
  `check.<key>`), beside the web's.
- An administrator gets at most one mail per run and per kind of notice,
  about ten minutes after a check starts failing; a check that flaps
  between `fail` and `ok` on every run never alerts, and one that flaps
  every two runs alerts and recovers each time — the page, not the mail,
  is where a flapping check is read.

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
