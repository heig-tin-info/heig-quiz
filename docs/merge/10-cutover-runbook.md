# 10. Cutover runbook (M8-05)

The operator's sequence for switching heig-classroom off and Quiz on: what
to do from a week before T0 to the decommission, who does it, the command,
the check that proves it worked and how to undo it. It replaces §6.5 B–E
and §6.7 of [`06-codespace-seb-infra.md`](06-codespace-seb-infra.md), and
is written for production as it stands on 2026-10-09. Rehearse it on
staging first: M8-06 runs this page there and times it (§7).

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
`caddy validate` and `systemctl reload caddy`. No step writes to a
production database by hand: data changes go through the import or the
product's own actions.

## 0. One-page checklist

Open decisions for the owner (each blocks the step named):

| # | Decision | Blocks | Suggested |
| --- | --- | --- | --- |
| O1 | **T0 date and window.** D20's target week (2026-10-05) has passed. Pick a morning that passes §1.4, with normal notice (7 days) or short notice (2 days, see the timeline below). Example under consideration: Sunday 2026-10-11, 09:00 Europe/Zurich, at short notice. | the announcement | a morning with no deadline before that evening |
| O2 | **Organizations.** Which classroom organizations still need Quiz's App installed and a Quiz classroom connected (§1.2)? | the rehearsal (M8-06) | install it on every organization of a live classroom; drop the archived and test classrooms in the mapping |
| O3 | **One final import or two.** D26 plans a first import while classroom still runs, then a `--final` one. Between the two runs, both Apps act on the same repositories: Quiz's ticker on what was imported, classroom's on everything (the M8-01 note "from M3-04"). | C3 | **one** `--final` import at T0, if M8-06's measured freeze C1→C8 stays within the M8-03b threshold (below) |
| O4 | **Staff-seat repositories.** ADR-077 asks the dry run to count the repositories classroom let its teachers accept. The import does not count them, so §1.3 gives the SQL. Import them (badged "Teacher") or leave them out? | the mapping (T-3) | import them: they are counted nowhere |
| O5 | **Deadline window.** The `--final` pre-flight refuses a live assignment whose deadline (plus grace) falls within `--window-hours` of the run, 24 by default. The window only has to cover the freeze and the catch-up (C1→C8, ≤ 2 h by the M8-03b threshold) with a margin. When the next classroom deadline falls the same evening, 24 h would refuse a morning T0 for nothing: pass `--window-hours 12` at C3, and use `W=12` in §1.4. | T0 | 24 h; 12 h when the next deadline is the same evening, at least 12 h after T0 |
| O6 | **The import's runtime.** The production image runs the import as `node dist/import-classroom.js` (#655, §1.6). | M8-06 | #655 merged and deployed |
| O7 | **The point of no return.** D lasts one to two weeks. | E | T0 + 7 days if C8 and D's checks are clean |

D20 and D22 are settled (08-decisions.md); only their date (O1) and their
inputs (O2, the mapping) remain.

**The M8-03b threshold** is set here, and 06 and the
[M8-03 card](history/09-tasks-delivered.md#m8-03-caddy-fragments) point to
it. If M8-06 measures a freeze from C1 to C8 longer than **2 h**, build
M8-03b (a read-only flag in classroom) before T0. C3 alone is not the
criterion.

**The sequence.** Each step has two dates: normal notice, then short
notice in brackets. At short notice the rehearsal (M8-06) is the staging
dry run, the day before T0.

- [ ] **P**: #655 (O6) deployed to production
- [ ] **T-7 [T-2]**: T0 chosen (O1) and checked with §1.4; announcement 1 sent (appendix A)
- [ ] **T-7 [T-2]**: the organization list (§1.2); teachers asked to install Quiz's App and connect their classrooms
- [ ] **T-5 [T-1]**: M8-06 rehearsed on fresh dumps (§7), go written in `PROGRESS.md`; its personal-data copies deleted the same day (§5.1)
- [ ] **T-3 [T-1]**: rosters fixed by hand (`lists.missingStudents`, `lists.skippedAssistants`); mapping validated (D22); O3, O4 and O5 settled
- [ ] **T-1 [T-1]**: a production dry run (§1.3), clean; §1.4 re-run; secrets checked (§1.5); backups checked and image tags recorded (§1.7); **Quiz deploys frozen** until C8 (§1.7); announcement 2 sent
- [ ] **T-1 h**: §1.4 re-run
- [ ] **T0 C1**: maintenance fragment, uptime probe paused, classroom deploys disabled, classroom app stopped
- [ ] **C2**: classroom dump, Quiz pre-migration dump, scratch database restored
- [ ] **C3**: `--apply --final`, exit 0, parity clean
- [ ] **C4**: dropped (M8-04)
- [ ] **C5**: workspace settings verified, nothing changed
- [ ] **C6**: redirect fragment, `check-classroom-redirects.sh` green against production
- [ ] **C7**: `reconcile.repos`, `reconcile.grades`, `reconcile.deliveries` run by hand
- [ ] **C8**: smoke list green; uptime monitors switched; Quiz deploys unfrozen; "done" message sent
- [ ] **D**: one to two weeks of observation (§4)
- [ ] **E / M9-01**: 302 changed to 308, final dump encrypted off the VM, every personal-data copy deleted, classroom removed, its App uninstalled last, repository archived

**Shell helpers**, used everywhere below. On the application VM, as `srv`
(`ssh srv@128.140.71.35`):

```bash
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
q() { (cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image "$@"); }   # Quiz
h() { (cd /srv/heig-classroom && docker compose -f compose.prod.yml --env-file .env.prod "$@"); }                # classroom
install -d -m 700 /srv/quiz/merge     # every cutover file: dumps, mapping, reports (they name people), §5.1
```

As `srvstg` (owner: `sudo machinectl shell srvstg@`):

```bash
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
s() { (cd ~/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image "$@"); }
install -d -m 700 ~/merge
```

The import (#655), in both shells. Its first argument is the compose
helper (`q` as srv, `s` as srvstg), its second the cutover directory on the
host (`/srv/quiz/merge` or `~/merge`), and the rest are the import's flags:

```bash
imp() {
  local c=$1 dir=$2; shift 2
  # --user 0: under rootless Docker, container root is the host account
  # itself (srv or srvstg), the only one that may read and write the 700
  # cutover directory. The image's `node` maps to a sub-uid that cannot.
  # --source-db names a database on DATABASE_URL's server: no password on
  # argv. $SUPER_ADMIN_EMAIL (the --actor, an admin) is expanded by the
  # container's shell, from the environment's env file.
  "$c" run --rm --no-deps -T --user 0 -v "$dir:/merge" app sh -c \
    'exec node dist/import-classroom.js --source-db hgc_cutover \
       --mapping /merge/mapping.json --actor "$SUPER_ADMIN_EMAIL" "$@"' sh "$@"
}
```

## 1. Before T0 (T-7 to T-1, or T-2 to T-1 at short notice)

### 1.1 Rehearsal

M8-06 (§7) runs §2 on staging with fresh dumps of both databases and times
every step. It needs #655 deployed. Its go comes before the production dry
run: at normal notice by T-5, at short notice the day before T0. A no-go
postpones T0, and a "postponed" note goes out.

### 1.2 Organizations still used by classroom (T-7 [T-2], agent (srv))

```bash
h exec -T postgres psql -U hgc hgc <<'SQL'
-- classroom's organizations and what each still carries
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
q exec -T postgres psql -U quiz quiz <<'SQL'
-- where Quiz's App acts (installed, not suspended, active), with the connected classrooms
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
dry run (§1.3) gives the authoritative answer per classroom, as a mapping
refusal:

- "the Quiz classroom is not connected to GitHub; its teacher connects it
  to `<org>` first";
- "… connected to X, not to the classroom's organization".

A journal of an organization where Quiz's App does not act is listed under
*Classroom journals* ("imported pending").

The App must also subscribe to `pull_request` (M3-07). Owner: GitHub →
Settings → Developer settings → GitHub Apps → `heig-quiz` → Permissions &
events, compared with the table in
[`github-app.md`](../development/github-app.md#permissions-and-events).

Rollback: none needed. Installing Quiz's App changes nothing for classroom
(D23).

### 1.3 Dry runs (on staging with M8-06, then T-1 in production)

**The mapping** (owner, D22). Write `/srv/quiz/merge/mapping.json` in the
shape of `apps/api/scripts/import-classroom/mapping.ts`: one row per
classroom, archived ones included, each either `target: {course, classroom}`
or `drop: true`. The first dry run prints every source classroom with its
organization under *Mapping*: that output is the list to start from.

**Staging dry run** (M8-06, §7). Both dumps go through the inbox. First, as srv
(agent):

```bash
/srv/quiz/scripts/staging-export.sh
h exec -T postgres pg_dump -Fc -U hgc hgc > /srv/staging-inbox/.hgc.dump.part \
  && chmod 640 /srv/staging-inbox/.hgc.dump.part && mv /srv/staging-inbox/.hgc.dump.part /srv/staging-inbox/hgc.dump
install -m 640 -g srvstg /srv/quiz/merge/mapping.json /srv/staging-inbox/mapping.json
```

Then as srvstg (owner):

```bash
~/quiz-staging/scripts/staging-refresh.sh
s exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)' -c 'CREATE DATABASE hgc_cutover OWNER quiz'
s exec -T postgres pg_restore -U quiz -d hgc_cutover --no-owner --role=quiz --exit-on-error < /srv/staging-inbox/hgc.dump
cp /srv/staging-inbox/mapping.json ~/merge/
imp s ~/merge --dry-run --report-json /merge/dry-run.json | tee ~/merge/dry-run.txt; echo "exit ${PIPESTATUS[0]}"
```

The same day, delete the staging copies (§5.1).

**Production dry run** (T-1, agent (srv) after the owner's go). It writes
in one transaction and rolls it back. It reads classroom through a scratch
copy, so classroom stays untouched:

```bash
h exec -T postgres pg_dump -Fc -U hgc hgc > /srv/quiz/merge/hgc-dry.dump
q exec -T postgres psql -U quiz -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)' -c 'CREATE DATABASE hgc_cutover OWNER quiz'
q exec -T postgres pg_restore -U quiz -d hgc_cutover --no-owner --role=quiz --exit-on-error < /srv/quiz/merge/hgc-dry.dump
imp q /srv/quiz/merge --dry-run --report-json /merge/dry-run-prod.json | tee /srv/quiz/merge/dry-run-prod.txt; echo "exit ${PIPESTATUS[0]}"
```

**What "clean" means**, section by section of the report:

- *Refusals*: none. A dry run lists them without refusing (exit 0);
  `--apply` would exit 2.
- *Pre-flight (source)*: every DATA check `ok`. The STATE checks read "would
  refuse --final" while classroom runs.
- *Mapping*: every classroom resolved or dropped, and the teachers confirm
  the resolved course and classroom (D22).
- *Identity*: `ambiguous` = 0.
- *To settle by hand*: the missing students and skipped assistants are
  either fixed in Quiz's rosters by T-1 or accepted by the owner (D08
  addendum: nothing is created for them).
- *Parity*: no `MISSING`, no `RED LINES`. The GitHub-bound checks appear
  under "Checks not run".

**ADR-077 count** (O4): the repositories held by a staff member of their
classroom.

```bash
h exec -T postgres psql -U hgc hgc <<'SQL'
select c.id, c.name, count(*) as staff_repos
from student_repos r join assignments a on a.id = r.assignment_id join classrooms c on c.id = a.classroom_id
where c.teacher_id = r.user_id
   or exists (select 1 from classroom_staff s where s.classroom_id = c.id and s.user_id = r.user_id)
   or exists (select 1 from enrollments e where e.classroom_id = c.id and e.user_id = r.user_id and e.staff)
group by c.id, c.name order by c.name;
SQL
```

Rollback: none needed. A dry run commits nothing; the scratch database
stays until E (§5.1).

### 1.4 Choosing T0 (T-7 [T-2], re-run at T-1 and T-1 h; agent (srv))

Run on the VM with the helpers of §0. `W` is the `--window-hours` that C3
will pass (O5):

```bash
T0='YYYY-MM-DD HH:MM Europe/Zurich'      # the candidate (O1)
W=24                                     # or 12 (O5)
h exec -T postgres psql -U hgc hgc <<SQL
-- (1) classroom: live, unfrozen assignments with a deadline before T0 + W (the --final pre-flight)
select c.name as classroom, a.name, a.deadline_at at time zone 'Europe/Zurich' as deadline, a.grace_minutes,
       a.deadline_at + make_interval(mins => a.grace_minutes) > now() as grace_ahead
from assignments a join classrooms c on c.id = a.classroom_id
where a.state = 'published' and a.archived_at is null and a.frozen_at is null
  and a.deadline_at <= timestamptz '$T0' + make_interval(hours => $W)
order by a.deadline_at;
-- (2) classroom: review checkpoints due in [T0, T0 + W] (informative)
select a.name, m.name as checkpoint, m.due_at at time zone 'Europe/Zurich' as due
from assignment_milestones m join assignments a on a.id = m.assignment_id
where m.dispatched_at is null and m.due_at between timestamptz '$T0' and timestamptz '$T0' + make_interval(hours => $W);
SQL
q exec -T postgres psql -U quiz quiz <<SQL
-- (3) evaluations that may be live in [T0, T0 + 2 h]
select title, state, mode, opens_at at time zone 'Europe/Zurich' as opens, closes_at at time zone 'Europe/Zurich' as closes
from evaluations
where state in ('scheduled', 'lobby', 'running', 'paused')
  and coalesce(opens_at, timestamptz '$T0') < timestamptz '$T0' + interval '2 hours'
  and coalesce(closes_at, 'infinity') > timestamptz '$T0';
-- (4) project deadlines (plus grace) in [T0, T0 + 2 h]
select p.name, p.deadline_at at time zone 'Europe/Zurich' as deadline, p.grace_minutes
from projects p
where p.state = 'published' and p.archived_at is null
  and p.deadline_at + make_interval(mins => p.grace_minutes) > timestamptz '$T0'
  and p.deadline_at < timestamptz '$T0' + interval '2 hours';
-- (5) a repository's own deadline (plus its project's grace) in [T0, T0 + 2 h]
select p.name, r.id as repo, r.deadline_at at time zone 'Europe/Zurich' as own_deadline
from project_repos r join projects p on p.id = r.project_id
where p.archived_at is null and r.archived_at is null and r.frozen_at is null and r.deadline_at is not null
  and r.deadline_at + make_interval(mins => p.grace_minutes) > timestamptz '$T0'
  and r.deadline_at < timestamptz '$T0' + interval '2 hours';
-- (6) online projects (the workspace has no real class yet): expect 0
select count(*) as online_projects from projects where work_mode <> 'free' and archived_at is null;
SQL
```

**The date passes when:**

- no row of (1) has `grace_ahead = t`. Such a row blocks the date: move
  T0, or, when the deadline is that evening at least 12 h after T0, set
  `W=12` (O5);
- every row of (1) with `grace_ahead = f` (already past, waiting for
  classroom's ticker to freeze it) is gone by T-1 h, or C3 will refuse
  `deadlines`;
- (3), (4) and (5) return no row, and (6) returns 0.

Rows of (2) do not block. A checkpoint due during the freeze is dispatched
by Quiz after the import, late; tell its teacher.

### 1.5 Secrets (§6.4), T-1, agent (srv)

| Secret | State on 2026-10-09 | Check (counts, never values) |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH` + PEM, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | set, Quiz's own App (D23, M2-06) | `grep -cE '^GITHUB_(APP_ID\|APP_SLUG\|APP_PRIVATE_KEY_PATH\|WEBHOOK_SECRET\|APP_CLIENT_ID\|APP_CLIENT_SECRET)=.' /srv/quiz/.env.prod` → 6; Administration → System status → GitHub App: no failure |
| `CODESPACE_URL`, `CODESPACE_LAUNCH_SECRET` | set, the workspace is live (M6-04) | `grep -cE '^CODESPACE_(URL\|LAUNCH_SECRET)=.' /srv/quiz/.env.prod` → 2 |
| `SUPER_ADMIN_EMAIL` | set; it is the import's `--actor` | `grep -c '^SUPER_ADMIN_EMAIL=.' /srv/quiz/.env.prod` → 1 |
| `SCW_*`, `MAIL_FROM_NAME` | set; Quiz's sender is the one kept | System status → *Send me a test e-mail* |
| `LEGACY_CLASSROOM_COOKIE_SECRET` | **not used**: an old unsubscribe link gets a plain 302 to Quiz's settings (M8-02 drops the query) | none |
| Engine VM `PLATFORM_URL`, issuers | Quiz's instances since M6-04 | none at the cutover |
| Keycloak, classroom's `OIDC_*`, `COOKIE_SECRET` | not needed | none |
| Vault (ADR-010) | owner | the age-encrypted copy of `/srv/quiz/.env.prod` and `secrets/` is current; `/srv/heig-classroom/.env.prod` and its `secrets/` are added (rollback, then E) |

Nothing is staged at T0.

### 1.6 The import's runtime (prerequisite, O6)

PR #655 compiles the import into the production image. It runs as
`node dist/import-classroom.js`, and `--source-db <name>` names a database
on `DATABASE_URL`'s server, so no password goes on argv. `--help` exits 0.
M8-06 waits until #655 is deployed, then proves `imp` (§0) on staging with
the image production runs.

### 1.7 Backups and the deploy freeze (T-1)

- Owner: Hetzner Backups is enabled and its last slot is under 24 h old
  (Hetzner console). Optional: a manual VM snapshot on T0 morning.
- Agent (srv): `cat /srv/quiz/backup-status/last.json` shows `"ok":true`
  from today. `ls -lt /srv/heig-classroom/backups | head -3` shows today's
  `hgc-<date>.dump`.
- Agent (srv): record what runs (the rollback precondition, §3):

```bash
{ h ps -q app | xargs docker inspect --format 'classroom {{.Config.Image}} {{.Image}}'
  echo "classroom commit $(git -C /srv/heig-classroom rev-parse HEAD)"
  echo "quiz $(cat /srv/quiz/.env.image)"; } | tee /srv/quiz/merge/images.txt
```

- Owner: **freeze Quiz's production deploys** from T-1 until C8 is green.
  Approve no `production` deployment in that window; a run that waits is
  rejected or left waiting. C3 and the rollback assume that the image of
  `images.txt` is the one running.

### 1.8 Communication (owner)

Send appendix A at T-7 (or T-2 at short notice) and one day before (T-1), to
classroom's teachers and students (classroom's e-mail list, Teams, the
course pages). The teachers also get the mapping lines of their classrooms
and the lists of §1.3 to fix (D22).

## 2. T0: freeze and migrate (target ≤ 1 h)

Take the target times from M8-06's measured times plus a margin, and fill
them in after the rehearsal. Run the steps in order. A step whose check
fails is a no-go: go to its rollback (§3).

### C1 Freeze classroom (owner and agent (srv), ~5 min)

Owner, as srv, installs the maintenance fragment:

```bash
cp /srv/quiz/infra/caddy/classroom-maintenance.caddy /etc/caddy/conf.d/classroom.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

- Owner: pause classroom's monitor on the uptime service.
- Owner: disable classroom's deploys, so that a push to `heig-classroom`
  cannot restart it:
  `gh workflow disable ci.yml --repo heig-tin-info/heig-classroom`.
- Agent (srv): stop the app and keep it stopped across a reboot
  (`restart: always` would bring it back). Postgres and `backup` stay up.

```bash
h stop app && h ps -aq app | xargs docker update --restart=no
date +%F-%H%M > /srv/quiz/merge/t0.txt
```

Check:

```bash
/srv/quiz/infra/caddy/check-classroom-redirects.sh --maintenance https://classroom.chevallier.io   # all rows OK
h ps app        # no running container
```

Rollback, step by step:

1. Classroom's own fragment back:
   `cp /srv/heig-classroom/Caddyfile /etc/caddy/conf.d/classroom.caddy`,
   then validate and reload.
2. `h ps -aq app | xargs docker update --restart=always && h start app`.
3. `gh workflow enable ci.yml --repo heig-tin-info/heig-classroom`.
4. Resume the monitor.

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

There is no codespace step: classroom's portal has been stopped since
M6-04, and its data is already archived on the engine VM
(`/root/classroom-codespace`).

Check: `ls -l /srv/quiz/merge/*-pre-merge-$TS.dump` shows two non-empty
files, and `q exec -T postgres pg_restore -l < /srv/quiz/merge/quiz-pre-merge-$TS.dump | head -3`
reads the Quiz dump. Then note the run count before C3:

```bash
q exec -T postgres psql -U quiz quiz -Atc 'select count(*) from import_classroom.runs' | tee /srv/quiz/merge/runs-before.txt
```

Rollback: nothing was written, so C1's rollback.

### C3 The final import (agent (srv) after the owner's go)

Start it at least 10 minutes after C1's app stop: the pre-flight reads a
task run or a webhook received within the last 10 minutes as a live
classroom (`QUIET_MINUTES`).

```bash
imp q /srv/quiz/merge --apply --final --window-hours "$W" --report-json /merge/final.json | tee /srv/quiz/merge/final.txt; echo "exit ${PIPESTATUS[0]}"   # W as in §1.4 (O5)
```

| Exit | Report's first line | Meaning | Next |
| --- | --- | --- | --- |
| 0 | `apply (final): applied` | committed, parity clean, journals ingested | C5 |
| 0 | `nothing to do` | this exact import is already in the database | *Rows written* all 0, then C5 |
| 1 | (an error on stderr) | the script failed (config, connection, a bug) | authoritative: `select count(*) from import_classroom.runs` against `runs-before.txt`. Equal: nothing committed; fix and re-run if the cause is clear and quick, otherwise roll back. Greater: it committed, so read the report and decide as for exit 3 after a commit |
| 2 | `REFUSED: nothing written` | a refusal: the mapping, an ambiguous identity, the pre-flight (`source-stopped`, `queues-empty`, `webhooks-processed`, `deadlines`, a DATA check) | `source-stopped` within 10 min: wait and re-run. Anything else: roll back |
| 3 | `RED LINES: … nothing written` | a parity red line inside the transaction, rolled back | roll back |
| 3 | `applied`, with *RED LINES* listed | a GitHub-bound check failed **after** the commit (`journals re-ingested` in error). The data stays | owner decides: a journal error (its code) is fixed forward by a Refresh. Anything else: roll back |

The red lines (each is a no-go):

- a source row neither carried nor deliberately left out (`MISSING`);
- `courses`, `classrooms`, `github_organizations` or
  `github_classroom_links` changed (D22 addendum);
- a parity check `red`: repositories per project, `sum(teacher_points)`,
  frozen grades, grade-run links, latest push receipt, groups per project,
  members per group, journals re-ingested `error`.

A task left `running` by a hard stop refuses `source-stopped` for good.
Look at it in classroom's `scheduled_tasks`, then:

1. Start classroom again and stop it cleanly (`h start app`, wait for the
   task, `h stop app`).
2. Wait 10 min.
3. Redo C2's classroom dump and restore.

`queues-empty` lists the jobs left in `pgboss.job`. M8-06 says whether
classroom keeps delayed jobs there. If it does, the check needs a code fix
before T0, not an override. Never edit the scratch copy to pass a check.

Check: exit 0, outcome `applied`, `jq '.parity.redLines | length' /srv/quiz/merge/final.json` → 0,
and the run count is one more than `runs-before.txt`.

Rollback: §3, row "C3 committed".

### C4 Codespace identity remap: dropped

M8-04 is dropped (owner, 2026-10-09). Classroom's portal never served a
real class, and it has been stopped and disabled since M6-04. There is
nothing to remap.

### C5 Workspace settings: verify only (agent (srv))

`CODESPACE_*` are already set (§1.5), and Quiz's app does not restart.
Check: `curl -s https://quiz.chevallier.io/healthz` → `"status":"ok"`. An
imported project is never online: the import refuses a non-`free` work
mode (the `work-mode` DATA check).

### C6 Redirects (owner, ~5 min)

Owner, as srv:

```bash
cp /srv/quiz/infra/caddy/classroom-redirect.caddy /etc/caddy/conf.d/classroom.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

Check (agent (srv)):
`/srv/quiz/infra/caddy/check-classroom-redirects.sh https://classroom.chevallier.io`
→ every row OK, exit 0. Then click one real old link of an imported
classroom: it lands on the Quiz classroom page (§6.6, M8-02).

Rollback: the maintenance fragment again (C1's command), then §3.

### C7 Catch-up (owner in the UI, ~10 min)

Quiz's App saw every push during the freeze, but it acts only on
repositories the import has made known. So Quiz now catches up from the
repositories themselves (GR-14.3: a push reconciled after its deadline is
late, hence T0 away from deadlines). In Administration → Scheduled tasks,
press **Run now** on:

1. `reconcile.repos`: heads, invitations, protection;
2. `reconcile.grades`: the CI runs of quiet repositories;
3. `reconcile.deliveries`: anything Quiz's App received and left
   unprocessed.

`codespace.sync` is not needed: no imported project is online.

Check (agent (srv)):
`q exec -T postgres psql -U quiz quiz -c "select key, last_status, last_run_at from scheduled_tasks where key like 'reconcile.%' order by key"`.
All three show `ok`, with a `last_run_at` after T0.

Rollback: none of its own. The tasks are idempotent.

### C8 Smoke (owner, with the agent reading logs; ~15 min)

| # | Action | Expected |
| --- | --- | --- |
| 1 | Sign in with edu-ID as a teacher of an imported classroom | the classroom shows its projects, journal and roster |
| 2 | A student account with a classroom GitHub link: Settings | the GitHub account is shown linked (the import carried it) |
| 3 | A test push to the test organization's repository (`heig-quiz-classroom`, `TestCourse-A`) | a `webhook_deliveries` row with `processed_at` set within a minute: `select event, received_at, processed_at, error from webhook_deliveries order by received_at desc limit 5` |
| 4 | The teacher's project page of an imported project | repositories, scores and states equal classroom's (same ids): one spot check with §4's SQL |
| 5 | An old URL: `https://classroom.chevallier.io/classrooms/<old id>` | 302 → `/legacy/classroom/…` → the Quiz classroom |
| 6 | System status → *Send me a test e-mail* | received |
| 7 | An imported journal page as a student | it renders; `select sync_status, count(*) from classroom_journals group by 1` shows no `error` |
| 8 | Ruleset bypass (I57): on one imported repository, GitHub → Settings → Rules → `hgc-protect` / `hgc-deadline-lock` | Quiz's App can act. If only classroom's App is a bypass actor, the owner adds `heig-quiz` and records it |
| 9 | `q logs --since 30m app \| grep -iE 'error\|warn' \| tail -50` | nothing new beyond known noise |

Then, owner:

- uptime service: delete classroom's `/healthz` monitor (it now answers
  410). Quiz's monitor is unchanged. Optional: a monitor on
  `https://classroom.chevallier.io/` that expects 302.
- Quiz's production deploys are unfrozen.
- the "done" message (appendix A).
- `PROGRESS.md`: the M8-07 row, timings, outcome.

## 3. Rollback

Precondition: `/srv/quiz/merge/images.txt` (§1.7) names the classroom and
Quiz images and commits that ran. `/srv/heig-classroom` stays untouched
until E, and classroom's App never moved.

**What no rollback undoes.** Quiz's App acts on GitHub from C3 on, and
nothing reverses those actions:

- bot commits (deadline commits, protected-file reverts);
- deadline locks (`hgc-deadline-lock` rulesets);
- sync branches and their pull requests;
- review dispatches;
- the invitations and protection of `reconcile.repos`;
- C8's bypass changes.

Classroom, once back, starts from that state.

**Quiz is not frozen.** Between C2 and a restore of the pre-migration dump,
everything else written in Quiz is lost: evaluations, attempts, pages,
settings. That is why §1.4 keeps T0 free of evaluations, and why the
restore is only for the first hours.

| Stage | Rollback | Who |
| --- | --- | --- |
| Before T0 | nothing to undo; send a "postponed" note | owner |
| C1, C2 | C1's rollback | owner, agent (srv) |
| C3 failed, nothing committed (the run count equals `runs-before.txt`) | C1's rollback. Quiz is unchanged | owner, agent (srv) |
| C3 committed, before C6 | maintenance stays; stop Quiz's app, restore `quiz-pre-merge-$TS.dump` into a recreated database (`deployment.md` §6, *Restore*), start it; then C1's rollback. Quiz loses what was written since C2 | agent (srv) after go |
| After C6, before the point of no return | maintenance fragment again. Then **either** the pre-migration restore above (it loses every Quiz write since C2, so use it only within hours) **or** keep Quiz's data and stop Quiz acting on the imported projects. For the latter, see the steps below the table. Then C1's rollback; classroom's own App redelivers what it missed (`GET /app/hook/deliveries`). The cost grows daily: keep D short | owner decides |
| After the point of no return (E) | fix forward only | — |

**Keeping Quiz's data after C6.** There is no bulk archive path: the
product archives one project at a time (F-PROJ-16, which also stops its
groups through `stopProjects`).

1. Agent (srv) counts the imported projects that are not yet archived
   (read-only):
   `q exec -T postgres psql -U quiz quiz -Atc "select count(*) from projects where archived_at is null and id in (select target_id from import_classroom.id_map where source_table = 'assignments')"`.
2. The owner archives each of them in the UI (project → Settings →
   Archive). Each archive is audited.
3. The writes staff made in Quiz to imported data since T0 (`audit_log`)
   are replayed into classroom by hand.

## 4. D: observe (1–2 weeks)

Redirects stay **302**: browsers cache 301 and 308. Classroom stays
stopped and intact, and `hgc_cutover` stays for the spot checks. Daily, the
agent (srv) runs these checks and reports to the owner:

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
q logs --since 24h app | grep -ciE 'error'      # read them if the count grows
```

**Parity spot check** (ids are kept): pick a project id and compare
classroom's frozen copy with Quiz.

```bash
P=<project id>
q exec -T postgres psql -U quiz hgc_cutover -c "select count(*), count(frozen_grade_run_id), sum(teacher_points) from student_repos where assignment_id = '$P'"
q exec -T postgres psql -U quiz quiz -c "select count(*), count(frozen_at), sum(teacher_points) from project_repos where project_id = '$P'"
```

Also watch:

- `/healthz` stays `"attention":false`;
- the GitHub App's Advanced → Recent Deliveries shows no non-2xx (owner);
- teachers' reports;
- the VM's memory (I53): it should drop, since classroom's app no longer
  runs.

Go for the point of no return (owner, O7): no rollback-worthy issue is
open, and D's checks have been clean for three consecutive days.

## 5. E / M9-01: point of no return and decommission

In this order. Each step is the owner's unless it says otherwise.

1. **Permanent redirects.** Change `302` to `308` in
   `infra/caddy/classroom-redirect.caddy` (a PR, by an agent).
   `legacyRule`'s own 302s depend on identity and stay. Install the
   fragment as in C6 and run `check-classroom-redirects.sh`, updated in the
   same PR.
2. **Final dump, encrypted, off the VM** (agent (srv) makes it; the owner
   holds the key and the destination):
   `h exec -T postgres pg_dump -Fc -U hgc hgc | age -r <owner's age recipient> > /srv/quiz/merge/hgc-final-$(date +%F).dump.age`.
   The owner copies it to the vault's storage, then checks that it
   decrypts and that `pg_restore -l` reads it.
3. **Personal-data copies of the cutover** (agent (srv), the same day as
   step 2): the deletions of §5.1, production rows.
4. **Remove classroom's stack** (agent (srv) after go):
   - `h down -v` removes the containers and the `pgdata` and
     `keycloak-data` volumes;
   - `rm -rf /srv/heig-classroom`;
   - remove the line `command="/srv/heig-classroom/deploy.sh"` from
     `/home/srv/.ssh/authorized_keys`.

   Quiz keeps its own copy of the edu-ID key
   (`/srv/quiz/secrets/eduid-private-key.pem`): never revoke that JWK.
5. **CI and registry**: delete the `DEPLOY_SSH_KEY` secret and the
   `DEPLOY_USER` variable of `heig-tin-info/heig-classroom`, and delete the
   GHCR package `heig-classroom` (GitHub → organization → Packages).
6. **edu-ID**: in the SWITCH Resource Registry, remove classroom's redirect
   URI (`https://classroom.chevallier.io/app/auth/callback`), and its
   client if it is a separate one. Quiz's client and the shared key stay.
7. **Engine VM** (root): delete `/root/classroom-codespace` (M6-04's
   archive of classroom's portal) and `/etc/codespace/github-app.pem` if it
   remains.
8. **DNS and fragment**: keep `classroom.chevallier.io` and the redirect
   fragment for at least a year.
9. **Classroom's GitHub App, last**: uninstall `hgc-prod` from every
   organization, then delete the App.
10. **Archive** `heig-tin-info/heig-classroom`
    (`gh repo archive heig-tin-info/heig-classroom`).
11. **Close**: ADR-035 had #143 close at this step, but it was closed
    early, on 2026-10-05, as "not planned". Comment on it with the
    decommission's PR, then mark M9-01 done in `PROGRESS.md`.

### 5.1 Personal-data copies

Every copy the cutover makes holds students' names, addresses and grades.
Until it is deleted it is **unencrypted at rest**: only modes 700/640 and
the account boundaries protect it.

| Copy | Where | Deleted by | Deadline | Command |
| --- | --- | --- | --- | --- |
| staging scratch database | `hgc_cutover` in staging's PostgreSQL | owner (srvstg) | the day of each staging dry run and of M8-06 | `s exec -T postgres psql -U quiz -d postgres -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)'` |
| staging cutover directory | `~srvstg/merge` | owner (srvstg) | same day | `rm -rf ~/merge` |
| inbox copies | `/srv/staging-inbox/hgc.dump`, `mapping.json` | agent (srv) | same day | `rm -f /srv/staging-inbox/hgc.dump /srv/staging-inbox/mapping.json` |
| production scratch database | `hgc_cutover` in Quiz's PostgreSQL | agent (srv) | E, step 3 | `q exec -T postgres psql -U quiz -d postgres -c 'DROP DATABASE IF EXISTS hgc_cutover WITH (FORCE)'` |
| production cutover directory | `/srv/quiz/merge` (dumps, mapping, reports) | agent (srv) | E, step 3, once the encrypted final dump is verified (it keeps what must be kept) | `rm -rf /srv/quiz/merge` |

The staging import also wrote classroom's data into staging's own Quiz
database. Two steps remove it the same day:

1. The agent (srv) runs `/srv/quiz/scripts/staging-export.sh`, so that
   the inbox holds a fresh production copy without the import.
2. The owner (srvstg) runs `~/quiz-staging/scripts/staging-refresh.sh`.

## 6. Appendix A: announcements

The first announcement goes out at T-7, or at T-2 at short notice. Fill in
the placeholders: `<jour> <date>, <heure>` (T0), `<échéance>` / `<deadline>` (the day the
teachers must be connected by: T-3, or T-1 at short notice).

**First announcement (fr)**

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
> avant le <échéance>, puis validez la table de correspondance que vous recevrez.

**First announcement (en)**

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
> Quiz classrooms (Classroom → Settings → GitHub) before <deadline>, then
> validate the correspondence table you will receive.

**One day before**: the same text, headed "Rappel : demain" / "Reminder:
tomorrow". **After C8**: "La bascule est faite : utilisez désormais
quiz.chevallier.io." / "The switch is done: use quiz.chevallier.io from now
on."

## 7. M8-06: the rehearsal on staging

This is §2 on staging, timed, with a fresh dump of both databases and the
image production runs. It needs PR #655 deployed. At short notice it runs
the day before T0. The owner works as `srvstg` unless a step says otherwise.

1. Agent (srv): the dumps and the mapping into the inbox (§1.3, *Staging
   dry run*, first block). Note the time: it stands for C1.
2. `staging-refresh.sh`, then `hgc_cutover` restored (§1.3, second block,
   up to `pg_restore`). Time it as C2.
3. `imp s ~/merge --dry-run`, then `imp s ~/merge --apply --final --window-hours "$W"` (O5). Time
   both. The dump comes from a running classroom, so the STATE checks see
   a live source frozen in the copy:
   - `source-stopped` passes once the copy is 10 minutes old;
   - a job caught in `pgboss.job` or a task caught `running` refuses
     `queues-empty` or `source-stopped` for good;
   - a near deadline refuses `deadlines`.

   Record each such refusal and check that it is only that. Then rehearse
   with `--apply` alone. Never edit the copy to pass.
4. The same command again: expect `nothing to do` (idempotence).
5. The resolver on the imported data: open
   `https://quiz.dev.chevallier.io/legacy/classroom/classrooms/<old id>`
   and an old project link. Both land on the Quiz pages. M8-03 already
   checked the fragment itself.
6. Walk C8 rows 1, 4 and 7 with an allow-listed account
   (`LOGIN_ALLOWLIST`), and time the end of it as C8.
7. Re-scrub, so staging's ticker leaves the imported projects alone:
   `s exec -T postgres psql -U quiz -d quiz -v ON_ERROR_STOP=1 < ~/quiz-staging/scripts/staging-scrub.sql`.
8. Delete the personal-data copies (§5.1, staging rows), the same day.
9. Record in `PROGRESS.md`, *Rehearsal log*: the dump date, the durations
   (restore, import, C1→C8), the parity summary and go/no-go. Fill in §2's
   target times.

**Expected on staging, not a no-go**:

- staging's App acts on no production organization (N-SEC-18), so the
  imported journals stay `pending` and `journals re-ingested` reports
  them as `warn`;
- the dry run lists the GitHub-bound checks under "Checks not run";
- C8's GitHub rows (2, 3 and 8) cannot be walked.

**No-go**:

- a red line other than a journal held by the missing installation;
- a refusal other than the STATE ones above;
- an ambiguous identity;
- a measured freeze C1→C8 over 2 h. Then build M8-03b (the read-only
  flag) before T0, or split the import as D26 planned (O3).
