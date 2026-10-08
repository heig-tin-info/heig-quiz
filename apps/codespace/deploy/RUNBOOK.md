# The codespace portal on the engine VM — runbook

Two instances of `@quiz/codespace`, `prod` and `staging`, on the engine VM
`code.chevallier.io`, beside the code runner, deployed by the CI through the
VM's dispatcher (`infra/engine/deploy.sh`). The decisions and their reasons
are the M6-04 amendment of
[ADR-016](../../../docs/adr/ADR-016-runner-sur-vm-separee.md); the rest of the
VM is §3 of [the deployment runbook](../../../docs/development/deployment.md).

## The layout

The values (names, ports, platform URLs) are in `deploy/lib.sh`
(`cs_instance`); the network values (bridge, subnet, gateway, anchor) in
`infra/net/common.sh`. `<i>` is `prod` or `staging`.

| What | Where |
| --- | --- |
| Checkout the deploy runs from | prod: `/opt/quiz-runner` (approved commits only); staging: `/opt/quiz-engine-staging` |
| Portal (quadlet) | `/etc/containers/systemd/quiz-codespace-<i>.container` → `quiz-codespace-<i>.service` |
| Image the quadlet runs | `ghcr.io/heig-tin-info/quiz-codespace:<i>` (the deployed sha, retagged) |
| Environment, secrets | `/etc/quiz-codespace/<i>/env` (0600) |
| Seccomp profile (host path) | `/etc/quiz-codespace/<i>/seccomp.json`, from `infra/seccomp/codespace.json` (the runner's plus `ptrace`, M6-05) |
| SQLite, volumes | `/srv/quiz-codespace/<i>/var`, `/srv/quiz-codespace/<i>/volumes` |
| Network, anchor, nftables | `quiz-codespace-net@<i>.service` |
| Shadow snapshots | `quiz-codespace-shadow@<i>.timer` |
| Slice (both instances, sessions, snapshots, backup) | `codespace.slice`, from `infra/engine/codespace.slice` (M6-05) |
| Backup export (both instances) | `/usr/local/lib/quiz-codespace/backup-export.sh`, pulled daily by the application VM |
| Caddy site, access log | `/etc/caddy/conf.d/quiz-codespace-<i>.caddy`, `/var/log/caddy/quiz-codespace-<i>.log` |
| Host-level copies (both instances) | `/usr/local/lib/quiz-codespace/`, `/etc/apparmor.d/codespace`, `/etc/systemd/system/quiz-codespace-*@.*` |
| Session containers | `cs-<i>-<session>`, label `heig-codespace.instance=<i>` |

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

### 2. The two checkouts

Production's checkout is the runner's, `/opt/quiz-runner`; its next
approved deploy moves it, or do it now. Staging gets a clone of its own,
which only the staging key ever moves:

```bash
cd /opt/quiz-runner && git fetch --quiet origin main && git checkout --quiet --detach "$SHA"
git clone --quiet https://github.com/heig-tin-info/heig-quiz.git /opt/quiz-engine-staging
cd /opt/quiz-engine-staging && git checkout --quiet --detach "$SHA"
ls /opt/quiz-runner/infra/engine/deploy.sh /opt/quiz-engine-staging/infra/engine/deploy.sh
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

Do not reload yet: the bootstrap validates and reloads. Check after step 10
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
network unit and the shadow timer; reloads Caddy. No portal starts before
its first deploy (step 10).

```bash
ip -br addr show cs0; ip -br addr show cs1        # 10.77.0.254/24, 10.77.1.254/24
nft list table inet codespace
```

### 7. The student image

Rebuild it from Quiz's sources, then run its acceptance test:

```bash
/opt/quiz-runner/apps/codespace/images/build.sh       # 1 to 2 min, ~1.5 GB, keep 3 GB free
/opt/quiz-runner/apps/codespace/images/c-dev/test.sh
```

### 8. The CI keys

```bash
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.before-m6-04
sed -i 's|command="/opt/quiz-runner/apps/runner/deploy/deploy.sh"|command="/opt/quiz-runner/infra/engine/deploy.sh production"|' /root/.ssh/authorized_keys
```

Then add the staging key, whose public half is the one in
`/home/srvstg/.ssh/authorized_keys` on the application VM
(`ci-deploy-staging@quiz`). The two lines:

```text
command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/opt/quiz-engine-staging/infra/engine/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
```

Why the runner's deploys keep working before and after this edit, and the
follow-up it enables: the header of `infra/engine/deploy.sh`.

### 9. Quiz's side: the URL and the secret

The secret travels VM to VM, never through the workstation's disk. The keys
must not already be in the files (`grep -c '^CODESPACE_' …` → 0):

```bash
# from the workstation: production
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/quiz-codespace/prod/env" \
  | ssh srv@portal.heig.chevallier.io 'umask 077; s=$(cat); printf "\nCODESPACE_URL=https://code.chevallier.io\nCODESPACE_LAUNCH_SECRET=%s\n" "$s" >> /srv/quiz/.env.prod'
# staging
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/quiz-codespace/staging/env" \
  | ssh srvstg@portal.heig.chevallier.io 'umask 077; s=$(cat); printf "\nCODESPACE_URL=https://code-dev.chevallier.io\nCODESPACE_LAUNCH_SECRET=%s\n" "$s" >> /home/srvstg/quiz-staging/.env.staging'
```

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

The next push to `main` deploys staging, and production after its
approvals (`deploy-production`, then `deploy-codespace-prod`). Or now, on
the VM, with a token that can read the package (a PAT with `read:packages`):

```bash
SSH_ORIGINAL_COMMAND="codespace prod $SHA <token>" /opt/quiz-runner/infra/engine/deploy.sh production
SSH_ORIGINAL_COMMAND="codespace staging $SHA <token>" /opt/quiz-engine-staging/infra/engine/deploy.sh staging
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
`deploy-staging`) job: same sha, image re-pulled by its sha. The dispatcher
refuses a sha from before M6-04 (it has no dispatcher). The migrations only
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

### Where to look

```bash
journalctl -u quiz-codespace-prod -n 50 --no-pager
tail -n 20 /var/log/caddy/quiz-codespace-prod.log
journalctl -u quiz-codespace-shadow@prod -n 5 --no-pager
podman ps --filter label=heig-codespace.instance=prod
```

### Rotating a launch secret

Edit `CODESPACE_LAUNCH_SECRET` in `/etc/quiz-codespace/<i>/env`, restart
`quiz-codespace-<i>`, then put the same value in Quiz's `.env.prod` (or
`.env.staging`) and recreate `app`. In between, a launch or a sync fails with
a named refusal; nothing is lost.

### Capacity

2 vCPU and 3.8 GB, not resized (owner, 2026-10-08). The two portals, their
sessions, the shadow snapshots and the backup export share `codespace.slice`,
below `quiz-runner.slice` (values: `infra/engine/*.slice`; deployment.md §3,
The slices). Staging and prod draw on the same slice: with
`CODESPACE_MEMORY=1536m` it holds **one session** at a time, with **768m**
(the template's value while test-only; an existing env file keeps its own) two. A second
1536m session pushes the slice to its ceiling: the kernel kills a session's
process, never a grading run. A real class needs the resize first (§6.2 of
`docs/merge/06-codespace-seb-infra.md`).

### Backup and restore

Both instances are exported daily by `backup-export.sh` and pulled by `srv`
on the application VM: deployment.md §3, Backup and restore of the codespace data.
The export's messages are in `srv`'s journal there (`journalctl --user -u quiz-engine-backup`), not in this VM's.
