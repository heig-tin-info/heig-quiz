# 6. Online workspace, SEB, infrastructure and cutover

## 6.1 Current topology

| | Classroom | Quiz |
| --- | --- | --- |
| App VM | `portal.heig.chevallier.io` (128.140.71.35, CPX12: 1 vCPU, 2 GB + 2 GB swap), user `srv`, rootless Docker, `/srv/heig-classroom`, app :3000 | same VM, `/srv/quiz` :3002; staging `srvstg` :3003 |
| Domain | `classroom.chevallier.io` | `quiz.chevallier.io`, `quiz.dev.chevallier.io` |
| Compose | `app`, `postgres:17` (`hgc`), `backup`; `keycloak` profile off | `app`, `postgres:17` (`quiz`), `backup` |
| Caddy | native; `conf.d/classroom.caddy` | `quiz.caddy`, `quiz-staging.caddy` |
| Engine VM | `code.chevallier.io` (2 vCPU, 3.7 GB, rootful Podman 5.7): codespace native in `/srv/codespace` (SQLite, systemd, Caddy :443 **with an access log**) | runner quadlet `/opt/quiz-runner`, Caddy :8443 (only 128.140.71.35 + `RUNNER_TOKEN`) |
| Backups | Hetzner Backups (7 daily) + daily dump on the VM; nothing off the VM; **engine VM: none** | same; each staging refresh doubles as a restore test |
| Secrets | `.env.prod`, `secrets/hgc-prod.private-key.pem`, `secrets/eduid-private-key.pem` | `.env.prod`, **the same edu-ID key and kid**, `/etc/quiz-runner/env` |
| CI/CD | checks → image → **deploy straight to production**, no staging, no approval | checks → images → staging (health gate) → production after approval, live-evaluation guard, both VMs |
| Codespace deploy | `push.sh` as `root@code…` from a workstation | — |

**The merge adds no VM**: the runner and the codespace already share the
engine VM; classroom and Quiz already share the app VM. After the cutover
the app VM loses one stack (~180 MB).

## 6.2 The online workspace (`C:apps/codespace`)

- Fastify 5 + SQLite (better-sqlite3, Drizzle), `codespace.service` on the
  engine VM, rootful Podman over `--remote`, one long-lived hardened
  container per (student, assignment) running code-server 4.137.0, image
  `codespace/c-dev:4.137.0` (Debian trixie, C toolchain, gdb, 1.5 GB),
  proxied at `/s/<session>/` (WebSocket included).
- Modules: `engine/` (Podman CLI, `containerArgs`), `sessions/` (lifecycle,
  GC, per-teacher quota, closed `CONTAINER_ENV_KEYS`, seeding, shadow repo),
  `git/` (git channel `10.77.0.254:9418` authenticated by source IP; a push
  lands in `staging.git`, a `PushEvent` is written, then relayed to GitHub),
  `proxy/`, `seb/` (full port of Moodle's `quizaccess_seb`), `classroom/`
  (`PUT /api/assignments/:id`, `GET /api/assignments/:id/sessions`,
  `GET /launch?token=`), `auth/`.
- **Maturity: deployed 2026-09-17, never used by a real class.**
  Smoke-tested with workstation-signed tokens on `heig-test-classroom2`; the
  App is not installed on `heig-tin-info`; **proof B (a real SEB) never
  run**; capacity about 2 sessions at 1.5 GB.
- Launch from classroom: HS256 tokens signed with
  `CODESPACE_LAUNCH_SECRET`. Sync (`codespace.sync` job ⇒
  `PUT /api/assignments/:id` with a 2-min service token; response
  `{configKey, sebLink}`); start (`GET /app/codespace/start/:aid`, navigable
  because it is SEB's `startURL`; checks enrollment, mode, publication,
  repository; mints a 5-min single-use launch token; 303 to
  `/launch?token=…`); the portal consumes the `jti` by insert first, then
  quota, SEB, session, `cs_session` cookie.

### Against Quiz's runner invariants 10–14

| Invariant | Codespace | Verdict |
| --- | --- | --- |
| 10 closed env list, tested | `CONTAINER_ENV_KEYS` (7), tested | compatible |
| 11 `--network none` | internal bridge, `--dns=none`, git channel | **sanctioned divergence** |
| 12 hardening flags | same + `apparmor=codespace`, tmpfs `mode=1777` | compatible |
| 12 nothing mounted, tmpfs `/work` | `-v <workDir>:/work:U`, persistent per student | **sanctioned divergence** |
| 13 `--remote`, rootful | same | compatible |
| 14 source rebuilt server-side | exam mode seeds from the teacher's template | same spirit |

⇒ Invariants 11–12 of `CLAUDE.md` are scoped to `apps/runner`;
`apps/codespace` keeps its own `CLAUDE.md` with these two divergences and
its own invariants (`TRUSTED_PROXY_IPS` required in production,
`SEB_VERIFIER=simulated` refused in production, single-use tokens, per-teacher
quota, the platform owns the `.seb` `startURL`, a token grants no role, a
`PushEvent` before the relay).

### Import as `apps/codespace`

A separate deployable, as today: it imports only `packages/*` and talks to
the platform through two signed HTTP messages. `@hgc/codespace` ⇒
`@quiz/codespace`; `hs256.ts` ⇒ `@quiz/domain`; contracts ⇒
`@quiz/contracts`; `CLASSROOM_URL` ⇒ `PLATFORM_URL` (alias kept); both
`heig-classroom` and `heig-quiz` accepted as `iss` during the transition;
SQLite stays (the portal must survive an app-VM outage); Node 22 ⇒ 24,
`better-sqlite3` built in CI on the target glibc; integration tests out of
CI.

### Sharing the engine VM

- Resize before a real class (CPX41 8 vCPU / 16 GB ≈ 8 sessions; measure a
  1-GB C session).
- One cgroup slice per service (`codespace.slice`, `quiz-runner.slice`,
  `CPUWeight`, `MemoryMax`) so an exam's sessions cannot starve grading.
- Orphan reaping stays scoped by label; never a global prune.
- One CI deploy dispatcher for both components (forced command).
- Images: nothing shared (Debian + code-server vs small Alpine per
  language); the Podman pin, the hardening list and the supply-chain rule
  are shared — decide "built on the VM" vs "built in CI, pinned by digest".
- Seccomp: two files; port the runner's tightenings to `codespace.json`
  (drop `mount*`, `unshare`, `setns`, `pivot_root`, `keyctl`, namespace
  flags of `clone`/`clone3`) **except `ptrace`** (gdb).
- The codespace's Caddy access log records `/launch?token=<JWT>`: mask it.
- Engine VM backups: a daily off-VM backup of volumes (`--numeric-ids`) and
  SQLite.

## 6.3 SEB, unified

| | Quiz (`Q:auth/seb.ts`, ADR-027) | Codespace (`C:apps/codespace/src/seb/`) |
| --- | --- | --- |
| Entry | one-time ticket in `launch_tickets` (kind `seb`, 5 min, hashed), `startURL = PUBLIC_URL/app/auth/seb/<secret>` | HS256 token, `startURL = CLASSROOM_URL/app/codespace/start/<id>` |
| Check | Config Key only (per-student plist, computed, never stored), before consuming the ticket | Config Key (stored with a salt) **and a mandatory BEK list**, constant-time |
| After | a confined `seb` session (6 h, default-deny routes) | an HMAC `exam_session` cookie bound to the client IP; the proxy checks only the cookie |
| URL filter | the Quiz host only | classroom + portal + `SEB_EXTRA_ALLOWED_HOSTS` (empty; edu-ID hosts needed) |

**Design** (D21):

1. `packages/seb`, pure: typed plist, SEB-JSON rules, Config Key,
   `expectedHash`, `hashesEqual`, `absoluteRequestUrl`,
   `buildSebConfig({startUrl, quitUrl, allowedHosts, examKeySalt?})`, the Moodle
   vectors and Quiz's 201-key vector. Quiz's `auth/seb.ts` moves onto it
   with **byte-identical output** (snapshot).
2. **The platform builds every `.seb`**, evaluations and projects:
   `startURL` stays Quiz's ticket route (no second sign-in inside SEB); a
   project's filter adds the codespace host; `SEB_EXTRA_ALLOWED_HOSTS`
   becomes a Quiz setting.
3. A `seb` session is confined to **an activity** (evaluation or project):
   a project session reaches the project page and "Open workspace", nothing
   else.
4. "Open workspace" from a `seb` session mints the HS256 token with a
   `seb: {configKey}` claim (this student's file); the portal checks
   `ConfigKeyHash` against it (+ BEKs if the activity has any), then sets
   its IP-bound `exam_session` as today.
5. BEKs optional per activity (evaluations too); empty = "Config Key only",
   Quiz's default.
6. **Proof B on the unified flow before the first SEB project** (Quiz
   ticket ⇒ Quiz page ⇒ cross-host 303 ⇒ `/launch`, on the fleet's SEB
   versions). If SEB drops its headers on the cross-host hop: an
   auto-submitted POST form to the portal.

Points 2–5 are implemented by M6-07 (card M6-07, "As delivered"). Two
limits it found, both for the product owner:

- **BEKs and a per-student file.** SEB computes a Browser Exam Key from its
  binary AND the configuration (the sibling's `analyse.md` §4.4). Quiz's
  `.seb` is per student (its start URL carries the one-time ticket), so a
  BEK is expected to differ from one student to the next, and a list typed
  by the staff to match nobody. Quiz therefore sends no BEK (Config Key
  only); the portal still accepts a list. **BEK list: after proof B step 7
  (per-student `.seb` likely gives per-student BEKs).** Evaluations keep
  the Config Key alone too.
- **Plan B is not built.** The auto-submitted POST form needs an inline
  script page on Quiz's side (its CSP forbids inline scripts) and a
  `POST /launch` on the portal whose hashed URL no longer carries the
  token: not cheap, and not safe to improvise without proof B's evidence.

### Proof B, by hand (pending, the product owner)

On a real Safe Exam Browser — each version and platform of the fleet
(Windows 3.x, macOS 3.x) — against staging (`quiz.dev.chevallier.io`) and
the staging portal, with `SEB_CONFIG_KEY_ENFORCE=0` (audit-only) on Quiz and
`SEB_VERIFIER=real` on the portal.

1. As a teacher with the workspace grant, create a project whose
   distribution repository is public, set *Where students work* to *Online,
   in Safe Exam Browser*, leave the Browser Exam Keys empty, publish it;
   the workspace section says *Workspace updated*.
2. As a student of the classroom, accept the project; the project page
   shows *Open in Safe Exam Browser*. Download the file; open it with SEB's
   configuration tool and note its Config Key; check its URL filter lists
   Quiz's host and the portal's (and `SEB_EXTRA_ALLOWED_HOSTS`, if set).
3. Open the file in SEB within 5 minutes. **Expected**: the project page,
   no sign-in, nothing else of Quiz reachable (try the breadcrumb: *You
   have left the exam*). The audit log has `auth.seb_login` on the project;
   no `auth.seb_refused`.
4. In Quiz's audit, look for `auth.seb_config_key_mismatch` on the project:
   none means SEB sends the header on `fetch` (the page's API calls).
5. Click *Open workspace*. **Expected**: the editor opens on the portal.
   This is the cross-host 303 (Quiz `/app/codespace/start/:id` ⇒
   `portal/launch?token=…`): the portal log has `session opened from a
   platform launch token`, mode `exam`. A 403 *Session outside Safe Exam
   Browser* with `reason: missing-config-key-header` in the portal log
   means SEB dropped its header on the hop: plan B is needed. A
   `config-key-mismatch` means SEB hashed another URL (note the exact URL
   in the log).
6. Open the file's start URL, or the start route, in an ordinary browser:
   both refused.
7. Browser Exam Keys: read the BEK the configuration tool shows for this
   file; download a second file (another student, or the same later) and
   compare. Different keys confirm the limit above (leave the list empty);
   equal keys mean a list can work, and Quiz then gains a staff field for
   it (removed from M6-07 until this step).
8. Quit: the project page carries *Quit Safe Exam Browser*. Note the
   file's `quitURL` (`<Quiz host>/seb/quit`, `quitURLConfirm` false) in
   the configuration tool, then press the button. **Expected**: SEB closes
   at once, without a confirmation or a password. Open the file again
   (new download), sit an evaluation that requires SEB to the end: its
   closed screen's *Quit Safe Exam Browser* closes SEB too. The shortcut
   its line names (Ctrl+Q on Windows, ⌘Q on Mac) closes SEB as well, after
   a confirmation SEB may ask for. The workspace (on the portal) has no
   quit button: there, only the shortcut leaves SEB.
9. Record the versions, the outcome of each step and the logs in the card
   M6-07; only then turn `SEB_CONFIG_KEY_ENFORCE` on and open SEB projects
   to students.

## 6.4 Environment and secrets Quiz gains

These are Quiz's own App's (D23), set in M2-06, not at the cutover; its
slug is its own (classroom's is `hgc-prod`).

- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH`
  + the PEM (copy through a container: it belongs to uid 100999),
  `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.
- `CODESPACE_URL`, `CODESPACE_LAUNCH_SECRET` (≥ 32 chars, same on both
  sides); `config.ts` refuses a URL without its secret and refuses
  `change-me`.
- Mail sender name: Quiz already has `MAIL_*`/`SCW_*` on the same Scaleway
  project; choose one.
- Optional `LEGACY_CLASSROOM_COOKIE_SECRET` (honour old unsubscribe links
  for 90 days).
- Not needed: Keycloak, classroom's `OIDC_*`, `COOKIE_SECRET`.
- Engine VM `/etc/codespace/env`: `PLATFORM_URL` = Quiz; issuer
  `heig-quiz` accepted.
- Everything into the age-encrypted vault (ADR-010).

## 6.5 Cutover

The commands, checks and owners are in
[`10-cutover-runbook.md`](10-cutover-runbook.md) (M8-05). It follows
production as of 2026-10-09. C2 has no codespace step and C4 is dropped:
classroom's portal has been stopped since M6-04 (M8-04 dropped).
`CODESPACE_*` are already set (C5). `LEGACY_CLASSROOM_COOKIE_SECRET` is
not used. Redirects become 308 at E.

**A — Ship.** The GitHub substrate and the journal are live with Quiz's
own App (D23) since M2/M4; what remains dark sits behind its switch
(`CODESPACE_URL` ⇒ routes 404, tasks no-op), through the normal pipeline.

**B — Prepare, no downtime.**
1. Every organization still used by classroom installs Quiz's App ("All
   repositories"); the list comes from the dry run of the import script.
2. Stage the codespace secrets in Quiz's `.env.prod`, inactive.
3. Engine VM: deploy the portal from the Quiz repository (check the Drizzle
   journal is identical), both issuers accepted.
4. Rehearse on staging (`srvstg`): restore a classroom dump, run the
   script, walk the product with `LOGIN_ALLOWLIST` and the staging App,
   **time it**.
5. Pick T0: no live workspace session, no deadline in [T0, T0 + window +
   grace], no live evaluation; announce a week and a day ahead.

**C — Freeze and migrate (target ≤ 1 h).**
1. Caddy maintenance fragment on `classroom.chevallier.io`
   (`infra/caddy/classroom-maintenance.caddy`): a bilingual 503
   with `Retry-After`; `/webhooks/github` answers 503 (classroom's App
   is idle from then on; Quiz's App received its own deliveries); pause the uptime probe;
   `docker compose stop app` (Postgres stays up). If the rehearsal takes
   > 2 h, build a read-only flag in classroom instead (M8-03b).
2. Dumps: `pg_dump -Fc hgc` ⇒ `backups/pre-merge-<ts>.dump`, a pre-migration
   dump of Quiz; `systemctl stop codespace`, SQLite backup, rsync of the
   volumes.
3. `import-classroom --apply` (classroom project ids kept).
4. Codespace identity remap (M8-04), `PLATFORM_URL` = Quiz, start the portal.
5. Set `CODESPACE_*` in Quiz (if M6 is in scope), `up -d app`.
6. Replace the maintenance fragment with the redirect fragment
   (`infra/caddy/classroom-redirect.caddy`; check it with
   `infra/caddy/check-classroom-redirects.sh https://classroom.chevallier.io`). Classroom's
   App is left installed and idle; its webhook points at a stopped service.
7. Catch up: `reconcile.repos`, `reconcile.grades` by hand (Quiz's App saw
   every push, but only for repositories the import just made known); `codespace.sync` for every online project (new Config Keys ⇒
   redistribute `.seb` files). Pushes during the freeze fall under GR-14.3
   (late if reconciled after the deadline) — hence T0 away from deadlines.
8. Smoke: edu-ID login, GitHub link, a webhook from a test push, the
   teacher's project page, a student Start ⇒ `/launch` ⇒ workbench ⇒
   `git push` relayed, an old URL redirects, an e-mail goes out. Point the
   probe at Quiz.

**D — Observe 1–2 weeks.** Redirects stay **302** (browsers cache
301/308). Classroom stopped but intact. At the declared point of no return,
switch to 301/308.

**E — Decommission.** Age-encrypted final dump off the VM; remove
classroom's containers, volumes, secrets, fragment, `/srv/heig-classroom`,
CI key, repository secret, GHCR package; keep the DNS name and redirect
fragment ≥ 1 year; uninstall classroom's App from the organizations and
delete it last; archive the repository.

## 6.6 Permalinks (`classroom.chevallier.io` ⇒ Quiz)

Rule: **proxy what machines call** (GitHub does not follow redirects on
webhooks), **redirect what humans click**, **410 for dead APIs**. One Quiz
route, `/legacy/classroom/*`, resolves old SPA paths through the preserved
UUIDs and the import id map — the mapping lives in tested code, not in
Caddy.

| Old | Target | How |
| --- | --- | --- |
| `POST /webhooks/github` | — | 410: classroom's App is idle, Quiz's App has its own URL (D23) |
| `/app/auth/github/callback?…` | Quiz `/settings` | 302 (a link in progress on classroom's App restarts on Quiz's) |
| `/setup/github/installed?…` | Quiz `/` | 302 (an installation of classroom's App after the cutover is a mistake: Quiz's App is the one to install) |
| `/app/auth/*` (edu-ID) | Quiz `/` | 302; keep the classroom redirect URI registered until decommission |
| `/app/codespace/start/:aid` (Start, **old `.seb` startURL**) | Quiz project start route | 302 via the resolver; old `.seb` files still fail (their filter does not allow Quiz): redistribute |
| `/app/email/unsub?…`, `List-Unsubscribe` | Quiz notification settings | 302 (sign-in), or honour the HMAC with the legacy secret for 90 days |
| `/classrooms/:id[/assignments/:aid[/groups]]`, `/classrooms/:cid/journal/<path>` | the Quiz classroom, project, groups, journal page | 302 via the resolver |
| `/settings`, `/admin`, `/` | Quiz equivalents | 302 |
| `/app/api/*`, `/app/events`, `/kc/*`, `/healthz`, `/metrics` | — | 410 |
| `/app/api/journals/:jid/assets/*` | — | 410: journal ids are not kept (D03), and an asset is only ever reached from its page |
| `/app/api/users/:uid/avatar` | Quiz equivalent | 302 via the resolver, else 410 |
| `code.chevallier.io/*` | same host | unchanged |

The fragment is `infra/caddy/classroom-redirect.caddy` (M8-03): Caddy
answers the 410 rows (the avatar excepted) and sends every other path to
`/legacy/classroom<path>`, which owns the rows; the query is dropped, the
path's percent-encoding kept. `infra/caddy/check-classroom-redirects.sh`
asserts each row's status and `Location`.

## 6.7 Rollback

Precondition: the sha of classroom's last good image is noted;
`/srv/heig-classroom` untouched until phase E.

| When | Rollback |
| --- | --- |
| A, B | re-run an older `deploy-production` job; codespace: switch its release symlink (restore SQLite if a migration crossed) |
| C, before step C6 | remove the maintenance fragment, reinstall `classroom.caddy`, `docker compose start app`, restore `CLASSROOM_URL`, the portal's SQLite and volumes if remapped, restore Quiz's pre-migration dump |
| After C6, before the point of no return | all of the above + classroom's own App redelivers what it missed (`GET /app/hook/deliveries`) + unset `CODESPACE_*` in Quiz + replay by hand the writes Quiz made to classroom-origin data since T0 (from the audit log). The cost grows daily: keep phase D short |
| After the point of no return | fix forward only |
