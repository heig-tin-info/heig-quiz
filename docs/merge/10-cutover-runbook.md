# 10. Cutover runbook (M8-05)

The operator's sequence for switching heig-classroom off and Quiz on: what
to do from a week before T0 to the decommission, who does it, the command,
the check that proves it worked and how to undo it. It applies §6.5–§6.7 of
[`06-codespace-seb-infra.md`](06-codespace-seb-infra.md) to production as it
stands on 2026-10-09. Where the two disagree, this page follows production
and says why. Rehearse it on staging first: M8-06 runs this page there and
times it (§7).

**Who** is one of:

- **owner**: the product owner. Only the owner may do these: the GitHub UI,
  the SWITCH registry, the uptime service, approvals, anything as `srvstg`,
  anything in `/etc/caddy/conf.d/` (the agent's sandbox blocks it), and
  every go/no-go.
- **agent (srv)**: an agent over `ssh srv@128.140.71.35`, after the owner
  has said go for that step. Reading is always allowed. Writing to a
  production database or stopping a service needs the owner's go in the
  session.
- **teachers**: through the owner.

Root SSH to the application VM is refused. `srv` may use sudo only for
`caddy validate` and `systemctl reload caddy`.

## 0. One-page checklist

Open decisions for the owner (each blocks the step named):

| # | Decision | Blocks | Suggested |
| --- | --- | --- | --- |
| O1 | **T0 date and window.** D20's target week (2026-10-05) has passed. Pick a weekday morning, at least 7 days out, that passes the checks of §1.4. | the announcement (T-7) | a Tuesday or Wednesday, 07:00–09:00 Europe/Zurich |
| O2 | **Organizations.** Which classroom organizations still need Quiz's App installed and a Quiz classroom connected? §1.2 produces the list. | the dry run (T-3) | install it on every organization of a live classroom; drop the archived and test ones in the mapping |
| O3 | **One final import or two.** D26 plans a first import while classroom still runs, then a `--final` one. Between the two runs, both Apps act on the same repositories: Quiz's ticker on what was imported, classroom's on everything (the M8-01 note "from M3-04"). | C3 | **one** `--final` import at T0, if M8-06 times it under 30 min |
| O4 | **Staff-seat repositories.** ADR-077 asks the dry run to count the repositories classroom let its teachers accept. The import does not count them; §1.3 has the SQL. Import them (badged "Teacher") or leave them out? | the mapping (T-3) | import them: they are counted nowhere |
| O5 | **Deadline window.** The `--final` pre-flight refuses any live assignment whose deadline plus grace falls within 24 h of the run (`--window-hours`, default 24). | T0 | keep 24 h; shorten it only by an explicit flag and only for a deadline you have checked |
| O6 | **The import's runtime.** The production image cannot run the import as is (§1.6). | M8-06 | a small code PR before M8-06 |
| O7 | **The point of no return.** D lasts one to two weeks. | E | T0 + 7 days if C8 and the D checks are clean |

D20 and D22 are settled (08-decisions.md); only their date (O1) and their
inputs (O2, the mapping) remain.

**The sequence:**

- [ ] **P**: the import runs from the production image (§1.6, O6); M8-06 rehearsed, go written in `PROGRESS.md`
- [ ] **T-7**: T0 chosen (O1), checked with the SQL of §1.4; announcement 1 sent (appendix A)
- [ ] **T-7**: the organization list (§1.2); teachers asked to install Quiz's App and connect their classrooms
- [ ] **T-5**: a staging dry run on fresh dumps (§1.3); the mapping and its lists sent to the teachers
- [ ] **T-3**: rosters fixed by hand (`lists.missingStudents`, `lists.skippedAssistants`); mapping validated (D22); O3, O4 settled
- [ ] **T-1**: a production dry run (§1.3), clean; secrets verified (§1.5); backups checked (§1.7); classroom's image noted; announcement 2 sent
- [ ] **T0 C1**: maintenance fragment, uptime probe paused, classroom deploys disabled, classroom app stopped
- [ ] **C2**: classroom dump, Quiz pre-migration dump, scratch database restored
- [ ] **C3**: `import-classroom --apply --final`, exit 0, parity clean
- [ ] **C4**: dropped (M8-04)
- [ ] **C5**: workspace settings verified, nothing changed
- [ ] **C6**: redirect fragment, `check-classroom-redirects.sh` green against production
- [ ] **C7**: `reconcile.repos`, `reconcile.grades` run by hand; no `codespace.sync` needed
- [ ] **C8**: smoke list green; uptime monitors switched; "done" message sent
- [ ] **D**: one to two weeks of observation (§4)
- [ ] **E / M9-01**: 302 changed to 308, final dump stored off the VM, classroom removed, its App uninstalled last, repository archived

Shell helpers, used everywhere below. On the application VM, as `srv`
(`ssh srv@128.140.71.35`):

```bash
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
q() { (cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image "$@"); }   # Quiz
h() { (cd /srv/heig-classroom && docker compose -f compose.prod.yml --env-file .env.prod "$@"); }                # classroom
install -d -m 700 /srv/quiz/merge     # every cutover file: dumps, mapping, reports (they name people)
```

As `srvstg` (owner: `sudo machinectl shell srvstg@`):

```bash
s() { (cd ~/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image "$@"); }
```

## 1. Before T0 (T-7 to T-1)

### 1.1 Rehearsal

M8-06 (§7) runs §2 on staging with fresh dumps of both databases and times
every step. It must pass before T-7: no T0 is announced without a timed
rehearsal whose parity report is clean.

### 1.2 Organizations still used by classroom (T-7, agent (srv))

These are classroom's organizations and what each still carries:

```bash
h exec -T postgres psql -U hgc hgc <<'SQL'
select o.login, o.github_org_id,
       count(distinct c.id) filter (where c.archived_at is null) as live_classrooms,
       count(distinct a.id) filter (where a.state = 'published' and a.archived_at is null) as live_assignments,
       count(distinct j.journal_id) as journals
from organizations o
join classrooms c on c.org_id = o.id
left join assignments a on a.classroom_id = c.id
left join classroom_journals j on j.classroom_id = c.id
group by 1, 2 order by 1;
SQL
```

And these are the organizations where Quiz's App acts (installed, not
suspended, active), with their connected classrooms:

```bash
q exec -T postgres psql -U quiz quiz <<'SQL'
select o.login, o.github_org_id,
       o.installation_id is not null and o.suspended_at is null and o.status = 'active' as app_acts,
       count(l.classroom_id) as connected_classrooms
from github_organizations o left join github_classroom_links l on l.org_id = o.id
group by o.id order by 1;
SQL
```

Every login in the first list that has live classrooms needs `app_acts = t`
and at least one connected classroom in the second list. A missing one is a
task for its teacher: install Quiz's App ("All repositories") and connect
the Quiz classroom from the classroom's Settings → GitHub (F-GH-02). The
dry run (§1.3) gives the authoritative answer per classroom: a Mapping
refusal "the Quiz classroom is not connected to GitHub; its teacher
connects it to `<org>` first" or "connected to X, not to the classroom's
organization". A journal of an organization where Quiz's App does not act
is listed under *Classroom journals* ("imported pending").

The App must also subscribe to `pull_request` (M3-07). Owner: GitHub →
Settings → Developer settings → GitHub Apps → `heig-quiz` → Permissions &
events. Compare with the events table of
[`github-app.md`](../development/github-app.md#permissions-and-events).

Rollback: none needed. Installing Quiz's App changes nothing for classroom
(D23).

### 1.3 Dry runs (T-5 on staging, T-1 in production)

**The mapping** (owner, D22). Write `/srv/quiz/merge/mapping.json` in the
shape of `apps/api/scripts/import-classroom/mapping.ts`: one row per
classroom, archived ones included, each either `target: {course, classroom}`
or `drop: true`. The first dry run prints every source classroom with its
organization under *Mapping*; that output is the list to start from.

**Staging dry run** (T-5; agent (srv), then owner (srvstg)): both dumps go
through the inbox.

```bash
# as srv: Quiz's copy, then classroom's, and the mapping
/srv/quiz/scripts/staging-export.sh
h exec -T postgres pg_dump -Fc -U hgc hgc > /srv/staging-inbox/.hgc.dump.part \
  && chmod 640 /srv/staging-inbox/.hgc.dump.part && mv /srv/staging-inbox/.hgc.dump.part /srv/staging-inbox/hgc.dump
install -m 640 -g srvstg /srv/quiz/merge/mapping.json /srv/staging-inbox/mapping.json
```

```bash
# as srvstg (owner)
~/quiz-staging/scripts/staging-refresh.sh
s exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)' -c 'CREATE DATABASE hgc_cutover OWNER quiz'
s exec -T postgres pg_restore -U quiz -d hgc_cutover --no-owner --role=quiz --exit-on-error < /srv/staging-inbox/hgc.dump
install -d -m 700 ~/merge && cp /srv/staging-inbox/mapping.json ~/merge/
s run --rm --no-deps -T --user 0 -v "$HOME/merge:/merge" app sh -c \
  'exec npx --yes tsx@4.23.0 scripts/import-classroom.ts --source "${DATABASE_URL%/quiz}/hgc_cutover" \
     --mapping /merge/mapping.json --actor "$SUPER_ADMIN_EMAIL" --dry-run --report-json /merge/dry-run.json' \
  | tee ~/merge/dry-run.txt
```

(The `npx tsx` form is the stopgap of §1.6. Once O6 lands, use the
command the fix documents. Staging's `app` is capped at 256 MB, and `compose
run` keeps the cap: an OOM kill there is a finding for O6, not a data
problem.)

**Production dry run** (T-1, agent (srv) after the owner's go). It writes
in one transaction and rolls it back. It reads classroom through a scratch
copy, so classroom stays untouched:

```bash
h exec -T postgres pg_dump -Fc -U hgc hgc > /srv/quiz/merge/hgc-dry.dump
q exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)' -c 'CREATE DATABASE hgc_cutover OWNER quiz'
q exec -T postgres pg_restore -U quiz -d hgc_cutover --no-owner --role=quiz --exit-on-error < /srv/quiz/merge/hgc-dry.dump
imp() {  # the import, in a one-off container of the deployed image, on Quiz's network
  q run --rm --no-deps -T --user 0 -v /srv/quiz/merge:/merge app sh -c \
    'exec npx --yes tsx@4.23.0 scripts/import-classroom.ts --source "${DATABASE_URL%/quiz}/hgc_cutover" \
       --mapping /merge/mapping.json --actor "$SUPER_ADMIN_EMAIL" "$@"' sh "$@"
}
imp --dry-run --report-json /merge/dry-run-prod.json | tee /srv/quiz/merge/dry-run-prod.txt; echo "exit ${PIPESTATUS[0]}"
```

**What "clean" means** (the report's sections):

- *Refusals*: none. A dry run lists them without refusing (exit 0).
  `--apply` would exit 2.
- *Pre-flight (source)*: every DATA check `ok`. STATE checks read "would
  refuse --final" while classroom runs, as expected.
- *Mapping*: every classroom resolved or dropped; the teachers confirm the
  resolved course and classroom (D22).
- *Identity*: `ambiguous` = 0.
- *To settle by hand*: the missing students and skipped assistants are
  either fixed in Quiz's rosters by T-1 or accepted by the owner (D08
  addendum: nothing is created for them).
- *Parity*: no `MISSING`, no `RED LINES`. A dry run lists the GitHub-bound
  checks as "Checks not run".

**ADR-077 count** (O4). This counts, per classroom, the repositories held
by a classroom staff member:

```bash
h exec -T postgres psql -U hgc hgc <<'SQL'
select c.name, count(*) as staff_repos
from student_repos r join assignments a on a.id = r.assignment_id join classrooms c on c.id = a.classroom_id
where c.teacher_id = r.user_id
   or exists (select 1 from classroom_staff s where s.classroom_id = c.id and s.user_id = r.user_id)
   or exists (select 1 from enrollments e where e.classroom_id = c.id and e.user_id = r.user_id and e.staff)
group by 1 order by 1;
SQL
```

Rollback: drop the scratch database (`DROP DATABASE hgc_cutover WITH
(FORCE)`). On staging, after any `--apply`, re-run the scrub (§7, step 7)
or refresh, so staging's ticker leaves the imported projects alone.

### 1.4 Choosing T0 (T-7, re-checked at T-1 and T-1 h; agent (srv))

T0 must have no classroom deadline (plus grace) within 24 h after T0 (the
`--final` pre-flight), no Quiz project deadline and no live evaluation in
[T0, T0 + 2 h], and no workspace session. Set the candidate on your
workstation, then run:

```bash
T0='2026-10-14 07:00 Europe/Zurich'      # the candidate (O1)
ssh srv@128.140.71.35 'cd /srv/heig-classroom && docker compose -f compose.prod.yml --env-file .env.prod exec -T postgres psql -U hgc hgc' <<SQL
-- classroom: live assignments whose deadline is before T0 + 24 h and not frozen (each refuses --final)
select c.name as classroom, a.name, a.deadline_at at time zone 'Europe/Zurich' as deadline, a.grace_minutes,
       a.deadline_applied_at is not null as applied
from assignments a join classrooms c on c.id = a.classroom_id
where a.state = 'published' and a.archived_at is null and a.frozen_at is null
  and a.deadline_at <= timestamptz '$T0' + interval '24 hours'
order by a.deadline_at;
-- classroom: review checkpoints due in the window (Quiz dispatches them after the import)
select a.name, m.name as checkpoint, m.due_at at time zone 'Europe/Zurich' as due
from assignment_milestones m join assignments a on a.id = m.assignment_id
where m.dispatched_at is null and m.due_at between timestamptz '$T0' and timestamptz '$T0' + interval '24 hours';
SQL
ssh srv@128.140.71.35 'cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image exec -T postgres psql -U quiz quiz' <<SQL
-- Quiz: evaluations that may be live during the window
select title, state, mode, opens_at at time zone 'Europe/Zurich' as opens, closes_at at time zone 'Europe/Zurich' as closes
from evaluations
where state in ('scheduled', 'lobby', 'running', 'paused')
  and coalesce(opens_at, timestamptz '$T0') < timestamptz '$T0' + interval '2 hours'
  and coalesce(closes_at, 'infinity') > timestamptz '$T0';
-- Quiz: project deadlines (plus grace) in the window
select p.name, p.deadline_at at time zone 'Europe/Zurich' as deadline, p.grace_minutes
from projects p
where p.state = 'published' and p.archived_at is null
  and p.deadline_at + make_interval(mins => p.grace_minutes) > timestamptz '$T0'
  and p.deadline_at < timestamptz '$T0' + interval '2 hours';
-- Quiz: online projects (the workspace has no real class yet: expect 0)
select count(*) as online_projects from projects where work_mode <> 'free' and archived_at is null;
SQL
```

The check passes when the first and the three Quiz queries return no row
and `online_projects` = 0. A row in the first query whose deadline plus
grace has already passed is classroom's ticker's to freeze. It must be
gone by T-1 h.

### 1.5 Secrets (§6.4), T-1, agent (srv)

| Secret | State on 2026-10-09 | Check |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH` + PEM, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | set, Quiz's own App (D23, M2-06) | `grep -cE '^GITHUB_(APP_ID\|APP_SLUG\|APP_PRIVATE_KEY_PATH\|WEBHOOK_SECRET\|APP_CLIENT_ID\|APP_CLIENT_SECRET)=.' /srv/quiz/.env.prod` → 6; Administration → System status → GitHub App: no failure |
| `CODESPACE_URL`, `CODESPACE_LAUNCH_SECRET` | set, the workspace is live (M6-04) | `grep -oE '^CODESPACE_(URL\|LAUNCH_SECRET)=.' /srv/quiz/.env.prod` → both; `curl -sI https://code.chevallier.io/ \| head -1` |
| `SCW_*`, `MAIL_FROM_NAME` | set; Quiz's sender is the one kept | System status → *Send me a test e-mail* |
| `LEGACY_CLASSROOM_COOKIE_SECRET` | **not used**: old unsubscribe links get a plain 302 to Quiz's settings (M8-02 dropped the query) | none |
| Engine VM `PLATFORM_URL`, issuers | Quiz's instances since M6-04 | none at the cutover |
| Keycloak, classroom's `OIDC_*`, `COOKIE_SECRET` | not needed | none |
| Vault (ADR-010) | owner | the age-encrypted copy of `/srv/quiz/.env.prod` and `secrets/` is current; add `/srv/heig-classroom/.env.prod` and its `secrets/` (rollback, then E) |

Nothing is staged at T0.

### 1.6 The import's runtime (prerequisite, O6)

`import:classroom` runs `scripts/import-classroom.ts` with `tsx`, a
devDependency. The image is `pnpm deploy --prod`, so it ships no `tsx`, and
nothing builds `scripts/` (`apps/api/tsconfig.json`). The commands above
use `npx --yes tsx@4.23.0` (the pinned version) inside the deployed image.
That form needs `scripts/` and `src/` present under `/app`, which is
unproven. It also fetches `tsx` from npm at run time.

Before M8-06, a code PR should make the image carry the import. Two ways:
`tsx` in `dependencies`, or the scripts compiled into `dist/`. M8-06 then
proves the documented command on staging with the same image that
production runs. Do not build on the VM (§5 of `deployment.md`).

### 1.7 Backups (T-1, owner and agent (srv))

- Hetzner Backups enabled, last slot under 24 h old (owner, Hetzner
  console). Optional: a manual snapshot of the VM on T0 morning.
- Quiz: `cat /srv/quiz/backup-status/last.json` shows `"ok":true` from
  today.
- classroom: `ls -lt /srv/heig-classroom/backups | head -3` shows today's
  `hgc-<date>.dump`.
- Note classroom's image (the rollback precondition, §3):

```bash
h ps -q app | xargs docker inspect --format '{{.Config.Image}} {{.Image}}' | tee /srv/quiz/merge/classroom-image.txt
git -C /srv/heig-classroom rev-parse HEAD | tee -a /srv/quiz/merge/classroom-image.txt
```

### 1.8 Communication (owner)

Send appendix A one week before (T-7) and one day before (T-1), to
classroom's teachers and students (classroom's e-mail list, Teams, the
course pages). The teachers also get the mapping lines of their classrooms
and the lists of §1.3 to fix (D22).

## 2. T0: freeze and migrate (target ≤ 1 h)

Target times are M8-06's measured times plus a margin. Fill them in after
the rehearsal. Run the steps in order. A step whose check fails is a no-go:
go to its rollback (§3).

### C1 Freeze classroom (owner, ~5 min)

```bash
# owner, as srv: the maintenance fragment
cp /srv/quiz/infra/caddy/classroom-maintenance.caddy /etc/caddy/conf.d/classroom.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

- Owner: pause classroom's monitor on the uptime service.
- Owner: stop classroom's deploys, so a push to `heig-classroom` cannot
  restart it:
  `gh workflow disable ci.yml --repo heig-tin-info/heig-classroom`
- Agent (srv): stop the app and keep it stopped across a reboot. Postgres
  and `backup` stay up.

```bash
h stop app && h ps -aq app | xargs docker update --restart=no
T0STAMP=$(date +%F-%H%M); echo "$T0STAMP" > /srv/quiz/merge/t0.txt
```

Check:

```bash
/srv/quiz/infra/caddy/check-classroom-redirects.sh --maintenance https://classroom.chevallier.io   # all rows OK
h ps app        # no running container
```

Rollback: `cp /srv/heig-classroom/Caddyfile /etc/caddy/conf.d/classroom.caddy`
+ validate + reload; `h ps -aq app | xargs docker update --restart=always && h start app`;
`gh workflow enable ci.yml --repo heig-tin-info/heig-classroom`; resume
the monitor.

### C2 Dumps (agent (srv), ~5 min)

```bash
TS=$(cat /srv/quiz/merge/t0.txt)
h exec -T postgres pg_dump -Fc -U hgc hgc > /srv/quiz/merge/hgc-pre-merge-$TS.dump
q exec -T postgres pg_dump -Fc -U quiz quiz > /srv/quiz/merge/quiz-pre-merge-$TS.dump
q exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)' -c 'CREATE DATABASE hgc_cutover OWNER quiz'
q exec -T postgres pg_restore -U quiz -d hgc_cutover --no-owner --role=quiz --exit-on-error \
  < /srv/quiz/merge/hgc-pre-merge-$TS.dump
```

No codespace step: classroom's portal has been stopped since M6-04, and
its SQLite and volumes are already archived on the engine VM
(`/root/classroom-codespace`).

Check: `ls -l /srv/quiz/merge/*-pre-merge-$TS.dump` shows two non-empty
files; `pg_restore -l` lists both
(`q exec -T postgres pg_restore -l < /srv/quiz/merge/quiz-pre-merge-$TS.dump | head -3`).

Rollback: nothing was written; C1's rollback.

### C3 The final import (agent (srv) after the owner's go)

Start it at least 10 minutes after C1's app stop. The pre-flight treats a
task run or a webhook received within the last 10 minutes as a live
classroom (`QUIET_MINUTES`). Use `imp` from §1.3.

```bash
imp --apply --final --report-json /merge/final.json | tee /srv/quiz/merge/final.txt; echo "exit ${PIPESTATUS[0]}"
```

| Exit | Report's first line | Meaning | Next |
| --- | --- | --- | --- |
| 0 | `apply (final): applied` | committed, parity clean, journals ingested | C5 |
| 0 | `nothing to do` | this exact import is already in the database | read *Rows written* (0), then C5 |
| 1 | (an error on stderr) | the script failed: config, connection, a bug. Nothing is committed unless the report says `applied` | fix and re-run if the cause is clear and quick; otherwise roll back |
| 2 | `REFUSED: nothing written` | a refusal: the mapping, an ambiguous identity, the pre-flight (`source-stopped`, `queues-empty`, `webhooks-processed`, `deadlines`, a DATA check) | `source-stopped` within 10 min: wait and re-run. Anything else: roll back |
| 3 | `RED LINES: … nothing written` | a parity red line inside the transaction, rolled back | roll back |
| 3 | `applied`, with *RED LINES* listed | a GitHub-bound check failed **after** the commit (`journals re-ingested` in error). The data stays | owner decides: a journal error (its code) is fixed forward by a Refresh. Anything else: roll back |

The red lines (each is a no-go) are:

- a source row neither carried nor deliberately left out (`MISSING`);
- `courses`, `classrooms`, `github_organizations` or
  `github_classroom_links` changed (D22 addendum);
- a parity check `red`: repositories per project, `sum(teacher_points)`,
  frozen grades, grade-run links, latest push receipt, groups per project,
  members per group, journals re-ingested `error`.

A task left `running` by a hard stop refuses `source-stopped` for good.
Look at it in classroom's `scheduled_tasks`. Start classroom again and stop
it cleanly (`h start app`, wait for the task, `h stop app`), then wait
10 min and redo C2's classroom dump and restore. `queues-empty` lists the
jobs left in `pgboss.job`. M8-06 says whether classroom keeps delayed jobs
there. If it does, the check needs a code fix before T0, not an override.
Never edit the scratch copy to pass a check.

Check: exit 0; the outcome `applied`; `jq '.parity.redLines | length' /srv/quiz/merge/final.json` → 0;
`select count(*) from import_classroom.runs` grew by one.

Rollback: before C6, restore Quiz's pre-migration dump (§3, row C3).

### C4 Codespace identity remap: dropped

M8-04 is dropped (owner, 2026-10-09). Classroom's portal never served a
real class, and it has been stopped and disabled since M6-04. There is
nothing to remap.

### C5 Workspace settings: verify only (agent (srv))

`CODESPACE_*` are already set (§1.5). Quiz's app does not restart.
Check: `curl -s https://quiz.chevallier.io/healthz` → `"status":"ok"`. An
imported project is never online: the import refuses a non-`free` work mode
(`work-mode` DATA check).

### C6 Redirects (owner, ~5 min)

```bash
# owner, as srv
cp /srv/quiz/infra/caddy/classroom-redirect.caddy /etc/caddy/conf.d/classroom.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

Check (agent (srv), or anywhere with curl ≥ 7.84):

```bash
/srv/quiz/infra/caddy/check-classroom-redirects.sh https://classroom.chevallier.io   # every row OK, exit 0
```

Then click one real old link of an imported classroom. It lands on the Quiz
classroom page (§6.6, M8-02).

Rollback: the maintenance fragment again (C1's command), then §3.

### C7 Catch-up (owner in the UI, or agent with an admin session, ~10 min)

Quiz's App saw every push during the freeze. It acts only on repositories
the import made known, so it now catches up from the repositories
themselves (GR-14.3: a push reconciled after its deadline is late, hence
T0 away from deadlines). In Administration → Scheduled tasks, use **Run
now** on:

1. `reconcile.repos`: heads, invitations, protection
   (`POST /app/api/admin/tasks/reconcile.repos/run`);
2. `reconcile.grades`: CI runs of quiet repositories;
3. `reconcile.deliveries`: anything Quiz's App received and left
   unprocessed.

`codespace.sync`: none. No imported project is online, and no Quiz project
changed mode. Check:

```bash
q exec -T postgres psql -U quiz quiz -c "select key, last_status, last_run_at from scheduled_tasks where key like 'reconcile.%' order by key"
```

All three should show `ok` with a `last_run_at` after T0.

Rollback: none of its own. The tasks are idempotent.

### C8 Smoke (owner, with the agent reading logs; ~15 min)

| # | Action | Expected |
| --- | --- | --- |
| 1 | Sign in with edu-ID as a teacher of an imported classroom | the classroom shows its projects, journal and roster |
| 2 | A student account with a classroom GitHub link: Settings | the GitHub account is shown linked (the import carried it) |
| 3 | A test push to the test organization's repository (`heig-quiz-classroom`, `TestCourse-A`) | a `webhook_deliveries` row with `processed_at` set within a minute: `select event, received_at, processed_at, error from webhook_deliveries order by received_at desc limit 5` |
| 4 | The teacher's project page of an imported project | repositories, scores and states equal classroom's (same ids): spot-check one project with §4's SQL |
| 5 | An old URL: `https://classroom.chevallier.io/classrooms/<old id>` | 302 → `/legacy/classroom/…` → the Quiz classroom |
| 6 | System status → *Send me a test e-mail* | received |
| 7 | An imported journal page as a student | it renders; `select sync_status, count(*) from classroom_journals group by 1` shows no `error` |
| 8 | ruleset bypass (I57): on one imported repository, GitHub → Settings → Rules → `hgc-protect` / `hgc-deadline-lock` | Quiz's App can act. If only classroom's App is a bypass actor, owner adds `heig-quiz` (or the org's admin) and records it |
| 9 | `q logs --since 30m app \| grep -iE 'error\|warn' \| tail -50` | nothing new beyond known noise |

Then, owner:

- uptime service: delete classroom's `/healthz` monitor (it now answers
  410). Quiz's monitor is unchanged. Optional: a monitor on
  `https://classroom.chevallier.io/` expecting 302.
- the "done" message (appendix A, after).
- `PROGRESS.md`: M8-07 row, timings, outcome.

## 3. Rollback

Precondition: classroom's image and commit are noted
(`/srv/quiz/merge/classroom-image.txt`, §1.7). `/srv/heig-classroom` stays
untouched until E. Classroom's App never moved.

| Stage | Rollback | Who |
| --- | --- | --- |
| Before T0 | nothing to undo: drop `hgc_cutover`; send a "postponed" note | agent (srv), owner |
| C1, C2 | C1's rollback: classroom's own fragment (`/srv/heig-classroom/Caddyfile`), `docker update --restart=always`, `h start app`, workflow re-enabled, monitor resumed | owner, agent (srv) |
| C3 failed (exit 1–3, nothing committed) | C1's rollback. Quiz is unchanged: the report says nothing was written | owner, agent (srv) |
| C3 committed, before C6 | stop Quiz's app, restore `quiz-pre-merge-$TS.dump` into a recreated database (`deployment.md` §6, *Restore*), start it; then C1's rollback. Quiz loses only what was written since C2 (no evaluation ran, §1.4) | agent (srv) after go |
| After C6, before the point of no return | maintenance fragment; then **either** the pre-migration restore above (it loses every Quiz write since T0, so use it only within hours) **or** archive the imported projects so Quiz's ticker leaves them alone (`update projects set archived_at = now() where id in (select target_id from import_classroom.id_map where source_table = 'assignments') and archived_at is null`), then C1's rollback. Classroom's App redelivers what it missed (`GET /app/hook/deliveries`). Replay by hand, from `audit_log` since T0, the writes staff made in Quiz to imported data. The cost grows daily: keep D short | owner decides |
| After the point of no return (E) | fix forward only | — |

## 4. D: observe (1–2 weeks)

Redirects stay **302**: browsers cache 301 and 308. Classroom stays
stopped and intact. Daily, agent (srv), reporting to the owner:

```bash
q exec -T postgres psql -U quiz quiz <<'SQL'
-- webhooks failed or stuck since yesterday
select event, count(*) filter (where error is not null) as failed,
       count(*) filter (where processed_at is null) as unprocessed
from webhook_deliveries where received_at > now() - interval '1 day' group by 1 order by 1;
-- imported journals not healthy
select sync_status, count(*) from classroom_journals cj
join import_classroom.id_map m on m.target_id = cj.classroom_id and m.source_table = 'classroom_journals'
group by 1;
-- scheduled tasks in error
select key, last_status, last_run_at from scheduled_tasks where last_status = 'error';
SQL
q logs --since 24h app | grep -ciE 'error'                 # read them if the count grows
```

**Parity spot check** (ids are kept): pick a project id, then compare
classroom's frozen copy with Quiz:

```bash
P=<project id>
q exec -T postgres psql -U quiz hgc_cutover -c "select count(*), count(frozen_grade_run_id), sum(teacher_points) from student_repos where assignment_id = '$P'"
q exec -T postgres psql -U quiz quiz -c "select count(*), count(frozen_at), sum(teacher_points) from project_repos where project_id = '$P'"
```

Watch also: `/healthz` `"attention":false`; the GitHub App's Advanced →
Recent Deliveries (owner) for non-2xx; teachers' reports; the VM's memory
(I53: classroom's app no longer runs, so it should drop).

Go for the point of no return (owner, O7): no rollback-worthy issue open,
D's checks clean for three consecutive days.

## 5. E / M9-01: point of no return and decommission

In this order. Each step is the owner's unless it says otherwise.

1. **Permanent redirects.** Change `302` to `308` in
   `infra/caddy/classroom-redirect.caddy` (PR, agent). `legacyRule` keeps
   its own 302s, which depend on identity. Then install the fragment as in
   C6, and run `check-classroom-redirects.sh`, updated in the same PR.
2. **Final dump, encrypted, off the VM** (agent (srv) makes it; the owner
   holds the key and the destination):
   `h exec -T postgres pg_dump -Fc -U hgc hgc | age -r <owner's age recipient> > /srv/quiz/merge/hgc-final-$(date +%F).dump.age`.
   Copy it to the vault's storage, check that it decrypts and that
   `pg_restore -l` reads it, then delete the local copies of every
   `/srv/quiz/merge/*.dump`.
3. **Remove classroom's stack** (agent (srv) after go):
   `h down -v` (containers, `pgdata` and `keycloak-data` volumes);
   `q exec -T postgres psql -U quiz -d postgres -c 'DROP DATABASE hgc_cutover WITH (FORCE)'`;
   `rm -rf /srv/heig-classroom`. Quiz keeps its own copy of the edu-ID key
   (`/srv/quiz/secrets/eduid-private-key.pem`): never revoke that JWK.
   Remove the line `command="/srv/heig-classroom/deploy.sh"` from
   `/home/srv/.ssh/authorized_keys`.
4. **CI and registry**: delete the `DEPLOY_SSH_KEY` secret and the
   `DEPLOY_USER` variable of `heig-tin-info/heig-classroom`; delete the
   GHCR package `heig-classroom` (GitHub → organization → Packages).
5. **edu-ID**: remove classroom's redirect URI
   (`https://classroom.chevallier.io/app/auth/callback`) and, if it is a
   separate client, that client from the SWITCH Resource Registry. Quiz's
   client and the shared key stay.
6. **Engine VM** (root): delete `/root/classroom-codespace` (M6-04's
   archive of classroom's portal) and `/etc/codespace/github-app.pem` if it
   remains.
7. **DNS and fragment**: keep `classroom.chevallier.io` and the redirect
   fragment for at least a year.
8. **Classroom's GitHub App, last**: uninstall `hgc-prod` from every
   organization, then delete the App.
9. **Archive** `heig-tin-info/heig-classroom`
   (`gh repo archive heig-tin-info/heig-classroom`).
10. **Close**: ADR-035 wanted #143 to close at this step. It was closed
    early, on 2026-10-05, as "not planned". Comment on it with the
    decommission's PR, then mark M9-01 done in `PROGRESS.md`.

## 6. Appendix A: announcements

**One week before (fr)**

> Objet : Classroom déménage dans Quiz le <jour> <date>, <heure>
>
> Bonjour,
>
> Le <jour> <date>, de <heure> à <heure + 1 h>, classroom.chevallier.io sera
> en maintenance puis remplacé par Quiz (quiz.chevallier.io). Vos projets,
> dépôts, notes et journaux y seront repris tels quels ; vos anciens liens
> mèneront à Quiz.
>
> Ce que vous avez à faire : rien, si votre compte GitHub est déjà lié dans
> classroom. Sinon, liez-le dans Quiz (Paramètres → GitHub) après la bascule.
> Évitez de pousser pendant la maintenance : un push est conservé, mais il
> n'est pris en compte qu'après.
>
> Enseignant·es : installez l'application GitHub de Quiz sur votre
> organisation et connectez vos classes Quiz (Classe → Paramètres → GitHub)
> avant le <T-3>, puis validez la table de correspondance que vous recevrez.

**One week before (en)**

> Subject: Classroom moves into Quiz on <day> <date>, <time>
>
> Hello,
>
> On <day> <date>, from <time> to <time + 1 h>, classroom.chevallier.io will
> be down for maintenance, then replaced by Quiz (quiz.chevallier.io). Your
> projects, repositories, grades and journals move over as they are; your
> old links will lead to Quiz.
>
> What you need to do: nothing, if your GitHub account is already linked in
> classroom. Otherwise, link it in Quiz (Settings → GitHub) after the switch.
> Avoid pushing during the maintenance: a push is kept, but only counted
> afterwards.
>
> Teachers: install Quiz's GitHub App on your organization and connect your
> Quiz classrooms (Classroom → Settings → GitHub) before <T-3>, then
> validate the correspondence table you will receive.

**One day before**: the same text, headed "Rappel : demain" / "Reminder:
tomorrow". **After C8**: "La bascule est faite : utilisez désormais
quiz.chevallier.io." / "The switch is done: use quiz.chevallier.io from now
on."

## 7. M8-06: the rehearsal on staging

The rehearsal is §2 on staging, timed, with a fresh dump of both
databases. Owner as `srvstg` unless noted.

1. Agent (srv): the dumps and the mapping into the inbox (§1.3, *Staging
   dry run*, first block).
2. `staging-refresh.sh`, then `hgc_cutover` restored (§1.3, second block,
   up to `pg_restore`). Time it.
3. A dry run (§1.3), then `--apply --final`. Time both. The dump comes
   from a running classroom, so the STATE checks see a live source frozen
   in the copy. `source-stopped` passes once the copy is 10 minutes old.
   A job caught in `pgboss.job` or a task caught `running` refuses
   `queues-empty` or `source-stopped` for good, and a near deadline refuses
   `deadlines`. Record each such refusal, check that it is only that, then
   rehearse with `--apply` alone. Never edit the copy to pass.
4. The same command again: expect `nothing to do` (idempotence).
5. The resolver on the imported data: open
   `https://quiz.dev.chevallier.io/legacy/classroom/classrooms/<old id>`
   and an old project link. Both land on the Quiz pages. M8-03 already
   checked the fragment itself.
6. Walk C8 rows 1, 4 and 7 on `quiz.dev.chevallier.io` with an
   allow-listed account (`LOGIN_ALLOWLIST`). Rows that need GitHub stay
   inert: staging's App acts on no production organization (N-SEC-18), so
   journals stay `pending` and the post-commit check reports it.
7. Re-scrub, so staging's ticker leaves the imported projects alone:
   `s exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 < ~/quiz-staging/scripts/staging-scrub.sql`.
8. Record the dump date, durations (restore, import, total), the parity
   summary and go/no-go in `PROGRESS.md`, *Rehearsal log*. Fill in §2's
   target times.

No-go if: a red line, a refusal other than the expected STATE ones, an
ambiguous identity, or C3 longer than 30 min (then build M8-03b, the
read-only flag, or split the import as D26 planned: O3).
