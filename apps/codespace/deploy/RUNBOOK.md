# The codespace portal on the engine VM — runbook

Two instances of `@quiz/codespace`, `prod` and `staging`, on the engine VM
`code.chevallier.io`, beside the code runner, deployed by the CI through the
VM's production dispatcher (`infra/engine/deploy.sh`) and its frozen
staging dispatcher (`infra/engine/staging-dispatch.sh`, installed by hand).
The decisions and their reasons are the M6-04 and 2026-10-11 amendments of
[ADR-016](../../../docs/adr/ADR-016-runner-sur-vm-separee.md); the rest of the
VM is §3 of [the deployment runbook](../../../docs/development/deployment.md).

## The layout

The values (names, ports, platform URLs) are in `deploy/lib.sh`
(`cs_instance`); the network values (bridge, subnet, gateway, anchor) in
`infra/net/common.sh`. `<i>` is `prod` or `staging`.

| What | Where |
| --- | --- |
| What the deploy runs | prod: `infra/engine/deploy.sh` from the checkout `/opt/quiz-runner` (approved commits only); staging: the frozen `/usr/local/libexec/quiz-engine/staging-dispatch.sh`, no checkout ([deployment.md §4](../../../docs/development/deployment.md#the-frozen-staging-dispatcher)) |
| Portal (quadlet) | `/etc/containers/systemd/quiz-codespace-<i>.container` → `quiz-codespace-<i>.service` |
| Image the quadlet runs | `ghcr.io/heig-tin-info/quiz-codespace:<i>` (the deployed sha, retagged) |
| Environment, secrets | `/etc/quiz-codespace/<i>/env` (0600) |
| Seccomp profile (host path) | `/etc/quiz-codespace/<i>/seccomp.json`, from `infra/seccomp/codespace.json` (the runner's plus `ptrace`, M6-05) |
| SQLite, volumes | `/srv/quiz-codespace/<i>/var`, `/srv/quiz-codespace/<i>/volumes` |
| Network, anchor, nftables | `quiz-codespace-net@<i>.service` |
| Shadow snapshots | `quiz-codespace-shadow@<i>.timer`, as root inside a sandbox (its unit: only the instance's volumes writable, the known secret locations denied, no device, network or other process); the only writer of `shadow.git` (the portal takes none), each volume bounded at 60 s (a timed-out one is logged, `journalctl -u quiz-codespace-shadow@<i>`, and skipped) and a run at 10 min: a safety net for the staff, never published by the platform, exported with the daily backup, its content untrusted (Recovering work from `shadow.git` below) |
| Collection readers | `cs-<i>-reader-<uuid>`, label `heig-codespace.role=reader`: one throwaway container per deadline collection, the volume read-only, `--network none`, 64 MiB, gone within the collection's 45 s (ADR-130, correction of 2026-11-16); never a session, never counted |
| Slice (both instances, sessions, snapshots, backup) | `codespace.slice`, from `infra/engine/codespace.slice` (M6-05) |
| Backup export (both instances) | `/usr/local/lib/quiz-codespace/backup-export.sh`, pulled daily by the application VM |
| Caddy site, access log | `/etc/caddy/conf.d/quiz-codespace-<i>.caddy`, `/var/log/caddy/quiz-codespace-<i>.log` |
| Host-level copies (both instances) | `/usr/local/lib/quiz-codespace/`, `/etc/apparmor.d/codespace`, `/etc/systemd/system/quiz-codespace-*@.*` |
| Session containers | `cs-<i>-<session>`, label `heig-codespace.instance=<i>` |
| Student image (both instances) | `CODESPACE_IMAGE` (`codespace/c-dev:4.137.0`) in the rootful store, rebuilt by a prod deploy (§7) |

## The switch from heig-classroom's portal

**One-time.** Trim this section once it has run. Everything runs as root on
the engine VM unless it says otherwise, in this order. Classroom's portal
stops at step 4 and Quiz's prod instance answers after step 10 (it was
never used by a real class; step 3 lists live sessions anyway).

### 1. Before: DNS and the merged commit

- **DNS (the owner, at Gandi):** `code-dev.chevallier.io`, a CNAME to
  `code.chevallier.io` (or the same A and AAAA records), TTL 300. Caddy obtains
  its certificate once the name resolves (`dig +short code-dev.chevallier.io`).
- A run of `main` containing M6-04 has pushed
  `ghcr.io/heig-tin-info/quiz-codespace:<sha>`. Call that full sha `SHA`.

### 2. The checkout

Production's checkout is the runner's, `/opt/quiz-runner`; its next
approved deploy moves it, or do it now:

```bash
cd /opt/quiz-runner && git fetch --quiet origin main && git checkout --quiet --detach "$SHA"
ls /opt/quiz-runner/infra/engine/deploy.sh
```

### 3. Back up classroom's portal

Stop it first, so the SQLite copy is consistent; keep the backup until
heig-classroom is cleaned up. **Never copy `/etc/codespace/github-app.pem`**
(classroom's App key, deleted at step 12).

```bash
podman ps -a --filter label=heig-codespace.session --format '{{.Names}} {{.Status}}'
systemctl stop codespace.service codespace-shadow.timer
du -sh /srv/codespace/var /srv/codespace/volumes && df -h /root
install -d -m 0700 /root/classroom-codespace
tar --numeric-owner -cpzf /root/classroom-codespace/srv-codespace-$(date +%F).tar.gz -C /srv/codespace var volumes
cp -a /etc/codespace/env /etc/caddy/Caddyfile /etc/systemd/system/codespace.service \
      /etc/systemd/system/codespace-net.service /etc/systemd/system/codespace-shadow.service \
      /etc/systemd/system/codespace-shadow.timer /root/classroom-codespace/
```

Quiz's prod instance starts with an empty database and empty volumes.

### 4. Retire classroom's units

```bash
systemctl disable --now codespace.service codespace-shadow.timer
# Not stopped: its `codespace` network and anchor are, with the same values, prod's from now on.
systemctl disable codespace-net.service
# Classroom's session containers. Correct only now, before any Quiz instance has run a session.
podman ps -aq --filter label=heig-codespace.session | xargs -r podman rm -f
```

### 5. Caddy

`/etc/caddy/Caddyfile` holds classroom's `code.chevallier.io { … }` block and
the `import /etc/caddy/conf.d/*.caddy` line. Delete the site block, keep the
import, and make the **global** default logger mask the launch token: the
sites' access logs are masked by their own fragment, but `reverse_proxy`
errors (an upstream down during a restart) go to the default logger, the
journal, with the request URI. Measured with Caddy 2.10: without this block
`/launch?token=<JWT>` reaches the journal, with it `token=REDACTED`. Merge
it into an existing global block if there is one:

```caddyfile
{
	grace_period 10s
	log default {
		output stderr
		format filter {
			wrap json
			fields {
				request>uri query {
					replace token REDACTED
				}
				request>headers>Referer delete
			}
		}
	}
}

import /etc/caddy/conf.d/*.caddy
```

```bash
grep -n 'code.chevallier.io\|3100' /etc/caddy/Caddyfile    # nothing
```

`grace_period 10s` cuts an old config's in-flight HTTP requests (a
download, a streamed answer) 10 s after a reload or a stop, where Caddy's
default waits for them without limit; it bounds nothing else. Do not
reload yet: the bootstrap validates and reloads. Check after step 10
that a 502 (`systemctl stop quiz-codespace-staging`, open a `/launch?token=x`
URL, start it again) leaves `journalctl -u caddy | grep -c 'token=x'` at 0.

### 6. Bootstrap the two instances

From production's checkout, for both (they install the host-level pieces):

```bash
/opt/quiz-runner/apps/codespace/deploy/bootstrap.sh prod
/opt/quiz-runner/apps/codespace/deploy/bootstrap.sh staging
```

Each run checks the socket, the `containers` range and Caddy's import; makes
`br_netfilter` persistent; creates the instance's directories; writes
`/etc/quiz-codespace/<i>/env` from `env.example` (a fresh
`CODESPACE_LAUNCH_SECRET` and `EXAM_COOKIE_SECRET`) **only if absent**;
installs the host-level files, the quadlet and the Caddy site; starts the
network unit and the shadow timer; reloads Caddy when it does not run that
site yet ([Caddy reloads](#caddy-reloads)). No portal starts before
its first deploy (step 10).

```bash
ip -br addr show cs0; ip -br addr show cs1        # 10.77.0.254/24, 10.77.1.254/24
nft list table inet codespace
```

### 7. The student image

The production portal deploy rebuilds it when `images/c-dev/` changed,
never staging ([ADR-016, amendment of 2026-11-18](../../../docs/adr/ADR-016-runner-sur-vm-separee.md#2026-11-18-the-prod-portal-deploy-rebuilds-the-student-image)):
the last step of `install.sh prod`, once the portal of the same commit
answers, is `deploy/student-image.sh`. Any file of that directory counts,
`test.sh` and the README included; a deploy that changes none costs an
`image inspect`. One build covers both instances (one tag, one store).
Running sessions keep their container until it restarts; new ones start on
the new image. A deploy forced past live sessions (`CODESPACE_FORCE_SHA`)
builds nothing and says so: run the script once they have closed.

**A red `deploy-codespace-prod` after `deploy: codespace prod at <sha>`**
means the portal is deployed and healthy but the image was not rebuilt
(build, acceptance test, under 3 GiB free under `/var/lib/containers`, or a
checkout whose `images/c-dev` differs from its commit). The image in
service is untouched and new sessions keep starting on it. The job prints
the end of the log; the whole of it is `/var/log/quiz-codespace-student-image.log`.
Fix on a branch; the next production deploy retries, or run the script
(never re-run the job alone during a live exam: The live-session guard).

By hand, as root, from production's checkout (it takes the deploy lock):

```bash
cd /opt/quiz-runner
apps/codespace/deploy/student-image.sh --check   # what a deploy would do; changes nothing
apps/codespace/deploy/student-image.sh           # rebuild if images/c-dev changed
apps/codespace/deploy/student-image.sh --force   # rebuild anyway (a base image's security fix)
```

The low-level commands it wraps stay usable (`images/build.sh`, then
`images/c-dev/test.sh`); an image built that way carries no label, so the
next production deploy rebuilds it once.

**A code-server bump** changes the image's tag (`images/c-dev/README.md`,
Modifying the image): when the commit reaches production, set the new
`CODESPACE_IMAGE` in both instances' env files, then run the script. Until
then the script warns that the tag and the Containerfile disagree, and
builds under the old tag.

The status-bar extension is part of the image: its version is in the log
(`test.sh` § 3, `heig.codespace-statusbar@0.4.0 installed and listed by
code-server`); the portal works with an older one, which ignores what it
does not know. The build downloads from Debian, GitHub (code-server), Open
VSX and PyPI (Baygon's wheels, hash-checked): the host policy
(`infra/engine/host.nft`) filters input only. The containers have no network.

### 8. The CI keys

```bash
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.before-m6-04
sed -i 's|command="/opt/quiz-runner/apps/runner/deploy/deploy.sh"|command="/opt/quiz-runner/infra/engine/deploy.sh production"|' /root/.ssh/authorized_keys
```

Then add the staging portal's key (`ci-deploy-staging-portal@quiz`, the
secret of the `staging-portal` environment), never the application's
`ci-deploy-staging@quiz`: deployment.md §4, *The frozen staging
dispatcher*. The two lines:

```text
command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/usr/local/libexec/quiz-engine/staging-dispatch.sh",restrict ssh-ed25519 AAAA… ci-deploy-staging-portal@quiz
```

Why the runner's deploys keep working before and after this edit, and the
follow-up it enables: the header of `infra/engine/deploy.sh`.

### 9. Quiz's side: the URL and the secret

The secret travels VM to VM, never through the workstation's disk. The keys
must not already be in the files (`grep -c '^CODESPACE_' …` → 0). Read the
secret on the code VM from `/etc/quiz-codespace/<instance>/env`
(`CODESPACE_LAUNCH_SECRET=`), and append, through a pipe, on the application
VM:

- as `srv`, to `/srv/quiz/.env.prod` (umask 077):
  `CODESPACE_URL=https://code.chevallier.io` and
  `CODESPACE_LAUNCH_SECRET=<the prod instance's>`;
- as `srvstg`, to `/home/srvstg/quiz-staging/.env.staging`:
  `CODESPACE_URL=https://code-dev.chevallier.io` and
  `CODESPACE_LAUNCH_SECRET=<the staging instance's>`.

The application reads them when its container is created: the next deploy,
or now (production: outside a live evaluation):

```bash
cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image up -d --wait app                 # srv
cd ~/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image up -d --wait app    # srvstg
```

Add the four secrets of `/etc/quiz-codespace/*/env` to the age-encrypted
vault (ADR-010).

### 10. Turn the CI deploys on, and the first deploy

```bash
# One REPOSITORY variable for both instances: deploy-codespace-prod reads it in a job-level
# `if`, where an environment variable is not available, and skips without asking an approval.
gh variable set CODESPACE_DEPLOY --repo heig-tin-info/heig-quiz --body 1
```

The next push to `main` deploys both instances after their approvals
(staging: `deploy-staging-portal`; production: `deploy-production`, then
`deploy-codespace-prod`). Or now, on
the VM, with a token that can read the package (a PAT with `read:packages`):

```bash
SSH_ORIGINAL_COMMAND="codespace prod $SHA <token>" /opt/quiz-runner/infra/engine/deploy.sh production
SSH_ORIGINAL_COMMAND="codespace staging $SHA sha256:<digest> <token>" /usr/local/libexec/quiz-engine/staging-dispatch.sh
```

Once both instances run, the `CODESPACE_DEPLOY` gate can go: remove the
condition from `.github/workflows/ci.yml` and the variable.

### 11. Smoke checks

```bash
curl -fsS https://code.chevallier.io/healthz; curl -fsS https://code-dev.chevallier.io/healthz
node /opt/quiz-runner/apps/codespace/deploy/smoke.mjs prod --port 3110              # health, secret, a sync
node /opt/quiz-runner/apps/codespace/deploy/smoke.mjs staging --port 3120 --launch  # + a real session
podman ps --filter label=heig-codespace.session --format '{{.Names}} {{.Labels}}'
grep -c 'token=ey' /var/log/caddy/quiz-codespace-staging.log            # 0
curl -s -o /dev/null -w '%{http_code}\n' https://code-dev.chevallier.io/api/assignments/x/sessions  # 403: only Quiz's VM passes
CS_INSTANCE=staging /usr/local/lib/quiz-codespace/infra/net/test.sh     # the network assertions on cs1
```

`smoke.mjs` takes the instance's port (`lib.sh`), reads the launch secret from its env
file and signs its tokens locally: `/healthz`, a service token (401 = a
wrong secret), a sync of the assignment `m6-04-smoke` on the public
`octocat/Hello-World`, and with `--launch` a `/launch` that must answer 303
to `/s/<session>/`. That session lives until the garbage collector takes it
(10 minutes); on prod it holds the live-session guard meanwhile, so use
`--launch` on staging. Then end to end through Quiz staging: a project in
`online` mode on a public distribution repository, *Resync*, *Open
workspace* as a student.

### 12. Delete classroom's GitHub App key

```bash
shred -u /etc/codespace/github-app.pem
ls /etc/codespace /root/classroom-codespace     # no .pem anywhere
```

## Rollback

**A bad portal release**: re-run an older run's `deploy-codespace-prod` (or
`deploy-staging-portal`) job: same sha, image re-pulled by its digest. The
production dispatcher refuses a sha from before M6-04 (it has no
dispatcher); the staging one checks out nothing, so any run whose image
job gave a digest redeploys. The migrations only
go forward: a release older than the newest `drizzle/` cannot read a newer
schema.

**Back to classroom's portal** (the switch fails):

```bash
gh variable set CODESPACE_DEPLOY --repo heig-tin-info/heig-quiz --body 0   # workstation (staging too)
systemctl stop quiz-codespace-prod.service
rm /etc/containers/systemd/quiz-codespace-prod.container /etc/caddy/conf.d/quiz-codespace-prod.caddy
systemctl daemon-reload
cp /root/classroom-codespace/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
systemctl enable --now codespace-net.service codespace.service codespace-shadow.timer
```

The `codespace` network, its anchor and the nftables table stay compatible
with classroom's. Classroom's portal needs its App key again only if step 12
already ran, which is why it is last.

## Day to day

### The live-session guard

A prod deploy refuses (exit 3, `deploy-codespace-prod` fails) while a session
container of the prod instance runs: a restart keeps the student containers,
but every open editor loses its connection for a few seconds. Podman is
asked, not the portal; a `ps` that fails refuses. Staging is not guarded.
Wait for the sessions to end (closed, or 10 minutes without a heartbeat) and
re-run the job, or force it:

```bash
gh variable set CODESPACE_FORCE_SHA --repo heig-tin-info/heig-quiz --body <the run's full sha>
# re-run deploy-codespace-prod, then:
gh variable delete CODESPACE_FORCE_SHA --repo heig-tin-info/heig-quiz
```

`DEPLOY_FORCE_SHA` (the application's guard) does not force this one.

**Never re-run `deploy-codespace-prod` alone during a live exam.** The
live-evaluation guard is the application's, in `deploy-production`; this
job runs after it and does not repeat it, so a re-run of this job alone
passes only the workspace's guard (and may rebuild the student image, §7).

### How long a workspace stays up

`SESSION_GRACE_MS` (10 minutes) after its tab closes, the portal closes a
session: container removed, volume kept, quota slot freed. An open tab keeps
it alive through its websockets, for at most `SESSION_MAX_HELD_MS` (12 hours)
after the tab last loaded the page; a reload renews it, a reconnect does not.
A forgotten tab is then closed after the cap plus the grace. One value serves
students and review sessions. Both live in `/etc/quiz-codespace/<i>/env`.

### Where to look

```bash
journalctl -u quiz-codespace-prod -n 50 --no-pager
tail -n 20 /var/log/caddy/quiz-codespace-prod.log
journalctl -u quiz-codespace-shadow@prod -n 5 --no-pager
podman ps --filter label=heig-codespace.instance=prod
podman ps -a --filter label=heig-codespace.role=reader   # empty but during a deadline collection
```

### Caddy reloads

The VM's Caddy reloads with `caddy reload --force` (its unit). A reload can
stay pending; the deploy detects it and says so. A deploy (the runner's
`install.sh`, this portal's `install.sh` for both sites, `bootstrap.sh`)
installs a site only when the rendered file differs from the installed one
(`caddy_site`), validates, then calls `caddy_apply` once
(`infra/engine/lib.sh`, tested by `infra/engine/caddy.test.sh`). It
reloads only when the running config, the admin API's
`http://127.0.0.1:2019/config/`, is not what `caddy adapt --config
/etc/caddy/Caddyfile` gives (compared as parsed JSON, with python3): a
change that adapts to the same config (a comment) reloads nothing, and a
re-run after a reload that did not take reloads again. Then `timeout 60
systemctl reload caddy` (the bound stops the client only; systemd's job
ends by the unit's own rules), and the same check:

| What the deploy sees | Outcome |
| --- | --- |
| Caddy already runs the files' config | no reload |
| the reload returns | done |
| no return within 60 s, or a failure, but Caddy runs the new config | warning |
| no return within 60 s, and the admin API does not answer | warning: the reload is still pending, the new config serves |
| a failure, and Caddy runs the old config | **fails**: `sudo journalctl -u caddy` |
| an earlier reload still pending, nothing changed | warning, no reload |
| an earlier reload still pending, a site changed | **fails**, no second reload queued behind it |

A deploy never restarts Caddy: that cuts every live session.

**A pending reload**:

```bash
sudo journalctl -u caddy --since -15min --no-pager
curl -sS -m 5 -o /dev/null http://127.0.0.1:2019/config/; echo $?   # 28: the admin API does not answer, a reload is pending
```

Re-run the deploy later: one whose sites are already installed only warns
while a reload is pending. As a last resort, in an exam-free window and with
no running session that matters (`podman ps --filter
label=heig-codespace.session`), the operator may `sudo systemctl restart
caddy`.

**`grace_period 10s`** (§5) is a line of `/etc/caddy/Caddyfile`, which no
deploy writes: on a VM set up without it, add it by hand at the top level of
the global block (not inside `servers`), in an exam-free window, then `sudo
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo
systemctl reload caddy`.

### Recovering work from `shadow.git`

`<volumes>/<student>/<project>/shadow.git` holds a snapshot of `work/` every
three minutes, written by the root timer only. It is the staff's safety net:
no collection, relay or restore reads it. It does leave this VM: the daily
backup export (`backup-export.sh`) carries the volumes, `shadow.git`
included, to the application VM, where it is just as untrusted. Its content
is **untrusted** because it is a host-side read of a tree the student wrote
while it was read: a file in it may hold the content of something outside
the volume (a link the student swapped in at the right moment), and a
gitlink in it may name a repository elsewhere on the host. Recovering a
student's work from it by hand, here or from a backup:

- read it with git only (`git --git-dir=<…>/shadow.git log`, `show`,
  `archive`), never check it out over a path that matters, and never as root
  into a shared directory;
- look at what you hand back before handing it: a file that is not the
  student's own work (a configuration, a key, another student's file) is
  dropped, and the incident reported;
- never push it to a student's repository as it is: a collection at a new
  deadline (F-PROJ-09 (1)) is the way work reaches GitHub, through the
  confined reader.

### Rotating a launch secret

Edit `CODESPACE_LAUNCH_SECRET` in `/etc/quiz-codespace/<i>/env`, restart
`quiz-codespace-<i>`, then put the same value in Quiz's `.env.prod` (or
`.env.staging`) and recreate `app`. In between, a launch or a sync fails with
a named refusal; nothing is lost.

### Capacity

The two portals, their sessions, the shadow snapshots and the backup export
share `codespace.slice`, below `quiz-runner.slice` (deployment.md §3, The
slices). Staging and prod draw on the same slice.

**The slice follows the VM's RAM.** `install_slices` (`infra/engine/lib.sh`)
writes `codespace.slice`'s memory lines into the drop-in
`/etc/systemd/system/codespace.slice.d/50-memory.conf`, and the caller's
`daemon-reload` applies them to the running slice (nothing restarts). A
failed read of the RAM or of the runner's slice writes nothing.

```text
MemoryMax  = MemTotal − quiz-runner.slice's MemoryLow (1536 MiB) − 256 MiB for the host,
             rounded to the nearest 256 MiB, at least 2048 MiB (the slice never shrinks)
MemoryHigh = 7/8 of MemoryMax
```

| MemTotal (RAM) | MemoryHigh | MemoryMax |
| --- | --- | --- |
| up to 3.87 GiB (the engine VM: 3814 MiB on 2026-11-15) | 1792M | 2048M, the floor |
| 16 GiB | 12768M | 14592M |
| 32 GiB | 27104M | 30976M |
| 64 GiB | 55776M | 63744M |

A VM reports a little less than its nominal size (a "16 GB" one about
15.6 GiB, hence about 14 GiB of slice). Swap is not counted: it is a cushion
beyond `MemoryMax`, not capacity. The runner's slice does not move: the
workspace slice gets what it leaves. Below about 3.6 GiB of RAM the floor
reaches into the runner's MemoryLow, and the deploy warns.

**How many sessions fit.** Each session is capped at `CODESPACE_MEMORY`
(1536m) and `CODESPACE_CPUS` (1), but uses far less; what fits is what they
use together:

```text
sessions(RAM)  ≈ (MemoryMax − 300 MiB for the two portals) / per-session p95
sessions(vCPU) ≈ (vCPU − 1 for the runner and the host) / per-session CPU at a busy moment
```

The per-session p95 and CPU are the load test's measures (below), corrected
by real tabs. Measured in a class of 44 real sessions (C lab, 2026-11-16, 31
GiB and 16 vCPU): 383 MiB mean and 531 MiB p95 per session at the slice's
peak (17.6 GiB), 2 to 6 vCPU busy in all, 4 at the start when everyone's
clangd parses at once. So 50 sessions want about 27 GiB of slice by the p95,
20 GiB by the mean. On the 2048M slice of the small VM that is
**3 sessions**.

**The cap is not the capacity.** That class ran under `CODESPACE_MEMORY=768m`
and the slice never ran short, yet 81 processes were killed inside sessions
that reached their own cap: a test runner holding the whole output of a
looping student program (Baygon 37, pytest 25) and, 19 times, the editor's
own node process. Hence 1536m. The cap bounds one runaway session; the slice
bounds them all, so the sum of the caps may exceed it.

**Other limits on the way to 50 sessions**, checked 2026-11-15:

| Limit | Value | 50 sessions |
| --- | --- | --- |
| Session addresses (`/24` per instance, gateway and anchor taken) | 252 | fits |
| `--userns=auto` pool (`containers:2147483647:2147483648`, 65536 uids each) | 32768 containers | fits |
| inotify (`fs.inotify.max_user_instances`): every container's instances count against root's, shared with the host (`deploy/sysctl.conf` says why) | 128 → 4096 | raised by the codespace **prod** deploy only, which the live-session guard refuses while sessions run: check it, and set it by hand if it is still 128 (step 3 below) |
| The teacher's quota (`maxActiveSessions`, default 2, at most 200 in the admin console) | per teacher | **raise it** (admin console), then *Resync* the project: the quota travels with the sync |
| Session start (`SESSION_HEALTH_TIMEOUT_MS`, 30 s from `podman run` to code-server's `/healthz`) | 30 s | a burst of launches on a starved CPU can exceed it: the session fails, the student relaunches; raise it in the env file if the load test at `--ramp 0` shows `5xx` |
| Disk, `/` and `/srv` (82 % used, 6.8 GB free on 2026-11-15) | per session: the repository, its builds, `shadow.git` every 3 min | a C lab is tens of MB a session; keep 3 GB free (`df -h / /srv`, `podman system df`) |
| Shadow timer (all volumes of an instance, one after another, every 3 min) | serial | seconds for 50 small repositories |
| `kernel.pid_max` (each session at most 256 pids) | 4194304 | fits |
| The portal's descriptors (a few websockets per tab, proxied twice) | `grep 'open files' /proc/$(podman --remote --url unix:///run/podman/podman.sock inspect -f '{{.State.Pid}}' quiz-codespace-prod)/limits` | hundreds needed |

#### Before a large class, in order

As root on the VM, unless it says otherwise. Steps 4 and 5 assume no real
session runs (the load test refuses otherwise).

```bash
# 1. Hetzner Cloud Console (the owner): power off, Rescale, "CPU and RAM only", power on.

# 2. The slice follows the new RAM (no restart).
cd /opt/quiz-runner && bash -c '. infra/engine/lib.sh && install_slices' && systemctl daemon-reload

# 3. Checks.
systemctl show codespace.slice quiz-runner.slice -p MemoryHigh,MemoryMax,MemoryLow
nproc; free -m
sysctl fs.inotify.max_user_instances      # 4096; if 128, the next line once:
install -m 0644 /opt/quiz-runner/apps/codespace/deploy/sysctl.conf /etc/sysctl.d/60-quiz-codespace.conf && sysctl -p /etc/sysctl.d/60-quiz-codespace.conf
curl -fsS http://127.0.0.1:3110/healthz; curl -fsS http://127.0.0.1:3120/healthz
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/health   # 401: the runner answers

# 4. Load test on staging, 50 sessions (after the resize only; before it, --sessions 4).
node /opt/quiz-runner/apps/codespace/deploy/loadtest.mjs staging --dry-run
node /opt/quiz-runner/apps/codespace/deploy/loadtest.mjs staging --sessions 50 --ramp 60s --hold 10m --work

# 5. Quiz (the owner): Admin → the teacher → workspace quota 60; then the project's
#    workspace page → Resync.

# 6. Before the class: record it.
systemd-run --unit=quiz-load-watch --property=Nice=10 \
  "$(command -v node)" /opt/quiz-runner/apps/codespace/deploy/loadtest.mjs watch --every 10s \
  --out /var/log/quiz-engine/load-$(date +%Y%m%d).jsonl

# 7. After the class.
systemctl stop quiz-load-watch
node /opt/quiz-runner/apps/codespace/deploy/loadtest.mjs report /var/log/quiz-engine/load-$(date +%Y%m%d).jsonl
```

#### Resizing the VM

On Hetzner: **power off** the server, *Rescale*, choose **CPU and RAM
only** (the disk stays, so the server can be scaled back down later),
**power on**, then steps 2 and 3 above. `install_slices` needs the checkout
at a commit that has it (2026-11-15 or later; a prod or runner deploy runs
it too). Scaling back down is the same, and the same command: the slice
shrinks with the RAM, never below 2048M.

#### Load test

`deploy/loadtest.mjs`, as root on the VM, against staging (prod needs
`--yes-prod`, a dry run too, and its sessions hold the prod deploy's
live-session guard until they close). The port is the instance's. **The
50-session run comes after the resize.** A first run on the current VM uses
`--sessions` sized to its slice: (MemoryMax − 300 MiB) / 400 MiB, rounded
down, so `--sessions 4` on 2048M.

It syncs the `lab` assignment `loadtest` on `octocat/Hello-World`, whose
quota holder is the synthetic `loadtest-teacher` with a quota of exactly
`--sessions` (no real teacher's grant is touched), launches students
`load-001`… over the ramp, times each launch to its 303 and code-server's
`/healthz` through the portal's proxy, and keeps them alive for the hold.
`--work` runs in each container what a student costs: clangd kept open on a C
file, a gcc build and a run every 20 to 40 s, `gdb -batch` one build in four.
It refuses to start while sessions run on either instance (they share the
slice; `--beside-live` to go on). Ctrl-C stops it cleanly; so does,
unless `--no-abort-on-oom`, an OOM kill in `codespace.slice` or memory PSI
`full avg10` above 10 %, and then it prints a `podman stop` line per load
session, to free the memory at once. It prints a line every 10 s, then a
table, and writes `/root/loadtest-<instance>-<time>.json`.

**What it does not load**: code-server's workbench (the browser's
websocket). Without a browser connected code-server starts no extension
host, the second-largest process of a real session. So, during the run,
open two or three real workspaces from Quiz staging in a browser, edit and
build in them, and compare their memory to the synthetic ones
(`systemd-cgtop -m codespace.slice`): the difference is what to add to the
per-session p95 before using the formula above.

**Too small** when, during the hold:

- `memory.events.local` of `codespace.slice` shows `oom_kill` > 0 (the
  slice itself ran short), or `high` growing fast (the slice is being
  throttled). `memory.events` is hierarchical: its `oom_kill` also counts a
  process killed at its own session's cap, which says the cap is too low
  for what students run, not the VM (the names:
  `journalctl -k | grep "Killed process"`);
- PSI `memory some avg10` stays above ~5 % (tasks wait for memory), or
  `cpu some avg10` above ~50 % (half the time something waits for a CPU);
- launch → 303 p95 above ~20 s, or any `5xx` or timeout among the launches.

The sessions close by themselves `SESSION_GRACE_MS` (10 min) after the run
(the portal has no API to close one); the script then prints the command
that removes the `load-*` volumes.

#### During a class

No monitoring screen exists: record the class with the sampler (step 6
above), which launches nothing and writes aggregates only (never a container
name, a student, a teacher or a course), one JSON line every 10 s, also
readable live with `journalctl -u quiz-load-watch -f`. The report (step 7)
gives the most sessions at once, the slice's peak memory and the
per-session mean there, the OOM kills and the worst PSI. Live, with what is
already on the VM:

```bash
sar -r 1                                            # memory (sysstat records it anyway: sar -r -f /var/log/sysstat/sa16)
sar -u 1                                            # CPU, %steal included
systemd-cgtop -m codespace.slice                    # the slice and each session's scope
cat /sys/fs/cgroup/codespace.slice/memory.events    # oom_kill must stay 0
cat /proc/pressure/memory /proc/pressure/cpu
```

### Host firewall

The VM's input policy (`table inet host`, beside this portal's
`inet codespace`) and its checks are deployment.md §3, The host firewall.
A new port the portal must serve is a line in `infra/engine/host.nft`
first; `CS_INSTANCE=<i> …/infra/net/test.sh` stays the network's test.

### Disk (audit M11): the owner's checklist

The work volumes, the staging repositories and the SQLite database (where
each push's `PushEvent`, the proof of submission, is written) share
`/srv/quiz-codespace/<i>`. The code bounds one push: `receive.maxInputSize`
on every staging repository (`RECEIVE_MAX_INPUT_BYTES`, 100 MiB,
`src/git/staging.ts`). It bounds nothing else: a student who fills their
`/work`, or pushes 100 MiB a hundred times, fills the file system, and every
student's next push is refused for want of room. What closes it is on the
VM, not in the repository:

- [ ] **A quota per work volume.** `/srv/quiz-codespace` on XFS mounted with
  `prjquota`, one project per `<student>/<assignment>` directory
  (`xfs_quota -x -c 'project -s …'`, `limit -p bhard=…`), set when a
  volume is created; or each volume a fixed-size loop or LVM volume. The
  portal creates the directories (`ensureStagingRepo`) and would need a
  hook to set the project: until then, a quota on the whole
  `volumes/` tree at least keeps the database's file system writable.
- [ ] **The database on a partition of its own.** `/srv/quiz-codespace/<i>/var`
  (`DATABASE_PATH`) on a file system the volumes cannot fill.
- [ ] **A free-space alert** on both file systems (say, under 15 %), in the
  VM's monitoring, before a push is refused.

The engine's image store fills the root disk otherwise. Each runner or prod
portal deploy deletes its repository's images that no tag names and no
container uses (`drop_old_sha_tags`, `infra/engine/lib.sh`); the frozen
staging dispatcher only untags, so staging's leftovers wait for the next prod
portal deploy. Before that fix (2026-11-15) a digest-pulled image survived
its untag as `<none>`. To reclaim them by hand, as root, under the deploy
lock (never `prune -a`, never `rmi -f`):

```bash
cd /opt/quiz-runner && flock -w 60 /run/quiz-engine-deploy.lock bash -c '. infra/engine/lib.sh
  for r in quiz-runner quiz-codespace; do drop_old_sha_tags "ghcr.io/heig-tin-info/$r" "$(git rev-parse HEAD)"; done'
podman --remote --url unix:///run/podman/podman.sock system df
```

### The service API's door (audit L25)

`PUT /api/assignments/:id`, `GET /api/assignments/:id/sessions` and
`POST /api/sittings/close` are on the public site, each behind a signed,
single-use token (ADR-078, amendment of 2026-10-11; ADR-089). Only Quiz's
application VM calls them:

- [x] A Caddy allow-list on `/api/*` for the application VM's addresses
  (#744): the `@service_elsewhere` matcher of `deploy/Caddyfile` answers
  403 to every other address. The addresses, IPv4 and IPv6, are the
  application VM's (deployment.md §1); production and staging Quiz both call
  from it. Every deploy reinstalls the site from the template, so a hand edit
  on the VM does not last: when that VM moves, change the template, beside
  `apps/runner/deploy/Caddyfile`. `smoke.mjs` calls the loopback port and is
  not affected; §11's `curl` checks the door, and the staff's workspace list
  in Quiz (staging, then prod) proves that Quiz still gets through.

### Framing (ADR-089 §10)

`frame-ancestors 'self' <CS_PLATFORM>` replaces `X-Frame-Options` in
`deploy/Caddyfile` (why: ADR-089 §10). No manual step: the prod deploy
rewrites both instances' sites (`install.sh`). The staging dispatcher writes
no site, so **staging gets the header at the next production deploy**, not
at its own; until then it keeps `SAMEORIGIN` and no station can frame it
(proof K waits for that). Check after a prod deploy:

```bash
curl -sI https://code.chevallier.io/ | grep -i -e frame -e content-security   # frame-ancestors 'self' https://quiz.chevallier.io
curl -sI https://code-dev.chevallier.io/ | grep -i -e frame -e content-security # … https://quiz.dev.chevallier.io
```

### Backup and restore

Both instances are exported daily by `backup-export.sh` and pulled by `srv`
on the application VM: deployment.md §3, Backup and restore of the codespace data.
The export's messages are in `srv`'s journal there (`journalctl --user -u quiz-engine-backup`), not in this VM's.
