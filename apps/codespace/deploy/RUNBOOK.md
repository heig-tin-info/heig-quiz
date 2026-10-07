# The codespace portal on the engine VM — runbook

Merge task M6-04. Two instances of `@quiz/codespace` on the engine VM
`code.chevallier.io`, beside the code runner, deployed by the CI through one
dispatcher shared with the runner. This file holds the one-time switch from
heig-classroom's portal and the day-to-day operations. The rationale is the
M6-04 amendment of [ADR-016](../../../docs/adr/ADR-016-runner-sur-vm-separee.md);
the rest of the VM is §3 of
[the deployment runbook](../../../docs/development/deployment.md).

## The layout

| | `prod` | `staging` |
| --- | --- | --- |
| Public name | `code.chevallier.io` (:443) | `code-dev.chevallier.io` (:443) |
| Platform | `https://quiz.chevallier.io` | `https://quiz.dev.chevallier.io` |
| systemd | `quiz-codespace-prod.service` (quadlet) | `quiz-codespace-staging.service` (quadlet) |
| Loopback port | 3110 | 3120 |
| Image | `ghcr.io/heig-tin-info/quiz-codespace:prod` (a sha, retagged) | `…:staging` |
| Environment (secrets) | `/etc/quiz-codespace/prod/env` (0600) | `/etc/quiz-codespace/staging/env` |
| Seccomp profile (host path) | `/etc/quiz-codespace/prod/seccomp.json` | `/etc/quiz-codespace/staging/seccomp.json` |
| Data (SQLite, volumes) | `/srv/quiz-codespace/prod/{var,volumes}` | `/srv/quiz-codespace/staging/{var,volumes}` |
| Podman network | `codespace`, bridge `cs0`, `10.77.0.0/24` | `codespace-staging`, bridge `cs1`, `10.77.1.0/24` |
| Git channel | `10.77.0.254:9418` | `10.77.1.254:9418` |
| Bridge anchor | `codespace-anchor` | `codespace-staging-anchor` |
| Network unit | `quiz-codespace-net@prod.service` | `quiz-codespace-net@staging.service` |
| Shadow snapshots | `quiz-codespace-shadow@prod.timer` | `quiz-codespace-shadow@staging.timer` |
| Caddy site | `/etc/caddy/conf.d/quiz-codespace-prod.caddy` | `/etc/caddy/conf.d/quiz-codespace-staging.caddy` |
| Access log (token masked) | `/var/log/caddy/quiz-codespace-prod.log` | `/var/log/caddy/quiz-codespace-staging.log` |
| Session containers | `cs-prod-<session>`, label `heig-codespace.instance=prod` | `cs-staging-<session>`, `…=staging` |
| Deployed by | the production key, after approval | the staging key, every push to `main` |

Shared by both: `/usr/local/lib/quiz-codespace/` (the network scripts, the
nftables table `inet codespace`, the shadow script), the AppArmor profile
`codespace`, the systemd templates. Only `bootstrap.sh` and a **prod**
deploy write them: a staging deploy runs commits nobody approved yet and
never changes what production's containers run under.

**Two instances, one engine.** Each portal reconciles its database against
Podman and removes the session containers it does not know. Every session
container therefore carries `heig-codespace.instance=<instance>`, and a
portal lists, stops and removes only the containers of its own instance
(`CODESPACE_INSTANCE`, `src/engine/index.ts`, tested in
`src/engine/instance.test.ts`); a container without that label (heig-classroom's)
is invisible to both. **Two networks, not one**: the instances could share the
`codespace` bridge, each git channel on its own port, but a portal
authenticates a push by the container's source address against its own
database, so a staging container would reach production's channel and be
judged by production's rows. Each instance has its own bridge, and the
nftables table pins each bridge to its own gateway (`infra/nft/codespace.nft`):
a staging container reaches neither production's channel nor its containers.

**The image.** The portal runs from an image the CI builds per sha
(`apps/codespace/Dockerfile`, no secret inside), as a Podman quadlet like the
runner: host networking (the git channel binds the bridge gateway, the proxy
reaches the containers' addresses), the rootful socket mounted, the data
directory bound at the same path (Podman resolves `-v <workDir>:/work:U` and
`seccomp=<path>` on the host), a read-only root, no capability,
`NoNewPrivileges`. How classroom's systemd hardening maps onto it is written
at the top of `quiz-codespace.container`. The **student** image
`codespace/c-dev:4.137.0` is built on this VM by `apps/codespace/images/build.sh`,
by hand, never by a deploy and never pulled: the same supply-chain rule as the
runner's language images.

## The switch from heig-classroom's portal

Everything below runs as root on the engine VM unless it says otherwise, in
this order. Classroom's portal stops at step 4 and Quiz's prod instance
answers after step 10: plan the window (the portal was never used by a real
class, so no student is cut off; check step 3's session list anyway).

### 1. Before: DNS and the merged commit

- **DNS (the owner, at Gandi):** `code-dev.chevallier.io`, a CNAME to
  `code.chevallier.io` (or the same A and AAAA records), TTL 300. Caddy obtains
  its certificate on its own once the name resolves
  (`dig +short code-dev.chevallier.io`); ports 80 and 443 are already open.
- A run of `main` that contains M6-04 has pushed
  `ghcr.io/heig-tin-info/quiz-codespace:<sha>` (Actions → the run → *image*).
  Call that full sha `SHA` below.

### 2. The checkout

The dispatcher and the bootstrap come from the checkout the runner already
uses. The next production deploy of the runner moves it too; do it by hand if
none has run since the merge:

```bash
cd /opt/quiz-runner
git fetch --quiet origin main && git checkout --quiet --detach "$SHA"
ls infra/engine/deploy.sh apps/codespace/deploy/bootstrap.sh
```

### 3. Back up classroom's portal

Stop it first, so the SQLite copy is consistent; keep the backup until
heig-classroom is cleaned up. **Never copy `/etc/codespace/github-app.pem`**
(classroom's GitHub App key, deleted at step 12).

```bash
podman ps -a --filter label=heig-codespace.session --format '{{.Names}} {{.Status}}'   # live sessions?
systemctl stop codespace.service codespace-shadow.timer
du -sh /srv/codespace/var /srv/codespace/volumes && df -h /root
install -d -m 0700 /root/classroom-codespace
tar --numeric-owner -cpzf /root/classroom-codespace/srv-codespace-$(date +%F).tar.gz -C /srv/codespace var volumes
cp -a /etc/codespace/env /etc/caddy/Caddyfile /root/classroom-codespace/
cp -a /etc/systemd/system/codespace.service /etc/systemd/system/codespace-net.service \
      /etc/systemd/system/codespace-shadow.service /etc/systemd/system/codespace-shadow.timer /root/classroom-codespace/
ls -la /root/classroom-codespace
```

Quiz's prod instance starts with an EMPTY database and empty volumes: an
assignment of classroom's has no Quiz project, and Quiz syncs its own.

### 4. Retire classroom's units

```bash
systemctl disable --now codespace.service codespace-shadow.timer
# NOT stopped: the `codespace` network and the `codespace-anchor` it set up
# are, with the same values, prod's from now on (quiz-codespace-net@prod).
systemctl disable codespace-net.service
# classroom's session containers (no instance label: Quiz's portals would never touch them)
podman ps -aq --filter label=heig-codespace.session | xargs -r podman rm -f
```

The last line is correct only now, before any Quiz instance has run a
session: afterwards, filter on the absence of the instance label instead.

### 5. Caddy: classroom's site block goes

`/etc/caddy/Caddyfile` holds classroom's `code.chevallier.io { … }` block
and the `import /etc/caddy/conf.d/*.caddy` line the runner added. Delete the
site block (its `log`, its `reverse_proxy 127.0.0.1:3100`), keep the import
line and any global options block:

```bash
nano /etc/caddy/Caddyfile
grep -n 'code.chevallier.io\|3100' /etc/caddy/Caddyfile    # nothing
grep -n 'conf.d/\*.caddy' /etc/caddy/Caddyfile             # the import
```

Do not reload yet: the bootstrap installs the prod site, validates and
reloads.

### 6. Bootstrap the two instances

```bash
/opt/quiz-runner/apps/codespace/deploy/bootstrap.sh prod
/opt/quiz-runner/apps/codespace/deploy/bootstrap.sh staging
```

Each run: checks the socket, the `containers` range and Caddy's import;
makes `br_netfilter` persistent; creates the instance's directories; writes
`/etc/quiz-codespace/<instance>/env` from `env.example` with a fresh
`CODESPACE_LAUNCH_SECRET` and `EXAM_COOKIE_SECRET` (`openssl rand -hex 32`,
distinct per instance) **only if the file does not exist**; installs the
host-level files, the AppArmor profile, the nftables table (cs0 and cs1),
the units, the quadlet and the Caddy site; enables and starts the instance's
network unit and shadow timer; reloads Caddy. It starts no portal: the
image `:prod` / `:staging` exists after the first deploy (step 10). Read
both env files once (`less /etc/quiz-codespace/prod/env`).

```bash
systemctl status quiz-codespace-net@prod quiz-codespace-net@staging --no-pager
ip -br addr show cs0; ip -br addr show cs1        # 10.77.0.254/24, 10.77.1.254/24
nft list table inet codespace                     # cs0 and cs1 rules
```

### 7. The student image

Classroom's `localhost/codespace/c-dev:4.137.0` is the same Containerfile
(classroom `a676c8c`, imported by M6-03). Rebuild it from Quiz's checkout so
the image comes from Quiz's sources, then run its acceptance test:

```bash
podman image exists codespace/c-dev:4.137.0 && echo present
/opt/quiz-runner/apps/codespace/images/build.sh       # 1 to 2 min, ~1.5 GB, keep 3 GB free
/opt/quiz-runner/apps/codespace/images/c-dev/test.sh
```

### 8. The CI keys: the dispatcher

root's `authorized_keys` holds one CI line today, the production key pinned
to the runner's script. **Moving the key to the dispatcher**: the same key,
another command. It is optional (the old path is now a forwarder to the
dispatcher with the production scope) but makes the file say what runs:

```bash
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.before-m6-04
sed -i 's|command="/opt/quiz-runner/apps/runner/deploy/deploy.sh"|command="/opt/quiz-runner/infra/engine/deploy.sh production"|' /root/.ssh/authorized_keys
grep -n 'infra/engine/deploy.sh' /root/.ssh/authorized_keys
```

The resulting line, and the NEW line for the staging key (its public half
is the one already in `/home/srvstg/.ssh/authorized_keys` on the application
VM, comment `ci-deploy-staging@quiz`):

```text
command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/opt/quiz-runner/infra/engine/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
```

Why the runner's next deploy cannot break: the CI keeps sending the runner
`<sha> <token>`, the form both the old script and the dispatcher accept.
The first production deploy after the merge runs the OLD copy of
`apps/runner/deploy/deploy.sh`, which moves the checkout and re-executes
itself, landing in the new forwarder, which hands over to the dispatcher;
the dispatcher reads that hand-over as the runner's deploy. Either line works
from then on. The one constraint: a line naming `infra/engine/deploy.sh`
needs a checkout that contains it (step 2). The production key may deploy
`runner prod` and `codespace prod`, the staging key `codespace staging`
only; anything else is refused before the registry login.

### 9. Quiz's side: the URL and the secret

The secret travels VM to VM, never through the workstation's disk. On the
application VM, the keys must not be there already
(`grep -c '^CODESPACE_' /srv/quiz/.env.prod` → 0):

```bash
# from the workstation: production
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/quiz-codespace/prod/env" \
  | ssh srv@portal.heig.chevallier.io 'umask 077; s=$(cat); printf "\n# --- Online workspace portal (ADR-047) ---\nCODESPACE_URL=https://code.chevallier.io\nCODESPACE_LAUNCH_SECRET=%s\n" "$s" >> /srv/quiz/.env.prod'
# staging
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/quiz-codespace/staging/env" \
  | ssh srvstg@portal.heig.chevallier.io 'umask 077; s=$(cat); printf "\n# --- Online workspace portal (ADR-047) ---\nCODESPACE_URL=https://code-dev.chevallier.io\nCODESPACE_LAUNCH_SECRET=%s\n" "$s" >> /home/srvstg/quiz-staging/.env.staging'
```

The application reads its environment when its container is created: the
next deploy picks it up, or recreate it now (production: outside a live
evaluation):

```bash
# srv
cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image up -d --wait app
# srvstg
cd ~/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image up -d --wait app
```

Add both secrets (and the two `EXAM_COOKIE_SECRET`s) to the age-encrypted
vault (ADR-010). Never one secret for both instances, and never classroom's:
`config.ts` refuses a URL without a secret of 32 characters or more.

### 10. Turn the CI deploys on, and the first deploy

```bash
gh variable set CODESPACE_DEPLOY --env staging --repo heig-tin-info/heig-quiz --body 1
gh variable set CODESPACE_DEPLOY --env production --repo heig-tin-info/heig-quiz --body 1
```

Then the next push to `main` deploys staging, and production after the
approval (the production job: application, runner, then the portal). Or now,
on the VM, by hand, with a token that can read the package (a classic PAT
with `read:packages`, or `gh auth token` when it has that scope):

```bash
SSH_ORIGINAL_COMMAND="codespace prod $SHA <token>" /opt/quiz-runner/infra/engine/deploy.sh production
SSH_ORIGINAL_COMMAND="codespace staging $SHA <token>" /opt/quiz-runner/infra/engine/deploy.sh staging
```

Each prints `deploy: codespace <instance> at <sha7>` once `/healthz`
answers on the loopback; a failure prints the unit's last journal lines and
exits non-zero.

### 11. Smoke checks

```bash
curl -fsS https://code.chevallier.io/healthz; curl -fsS https://code-dev.chevallier.io/healthz
node /opt/quiz-runner/apps/codespace/deploy/smoke.mjs prod            # health, secret, a sync
node /opt/quiz-runner/apps/codespace/deploy/smoke.mjs staging --launch  # + a real session
podman ps --filter label=heig-codespace.session --format '{{.Names}} {{.Labels}}'
grep -c 'token=ey' /var/log/caddy/quiz-codespace-staging.log          # 0: the token is masked
CS_INSTANCE=staging /usr/local/lib/quiz-codespace/infra/net/test.sh   # the P2 assertions on cs1
```

`smoke.mjs` signs its tokens locally with the instance's
`CODESPACE_LAUNCH_SECRET` (Node's standard library, no checkout build):
`/healthz`, a service token (a 401 means a wrong secret), a sync of the
assignment `m6-04-smoke` on the public `octocat/Hello-World`, and with
`--launch` a launch token whose `/launch` must answer 303 to `/s/<session>/`:
a student container really started. That session is left to the garbage
collector (10 minutes); on **prod** it holds the live-session guard
for those minutes, so prefer `--launch` on staging. Then end to end through
Quiz staging: a project in `online` mode on a PUBLIC distribution
repository, *Resync*, and *Open workspace* as a student.

### 12. Delete classroom's GitHub App key

Once the prod instance answers: nothing on this VM may hold
heig-classroom's App key (root invariant 15), and Quiz's portal refuses any
App credential anyway.

```bash
shred -u /etc/codespace/github-app.pem
ls /etc/codespace /root/classroom-codespace     # no .pem anywhere
```

`/etc/codespace/env` and `/srv/codespace` stay until heig-classroom is
cleaned up (the backup of step 3 holds them as well).

## Rollback

**A bad release of the portal** (CI deployed it, it misbehaves): re-run an
older run's `deploy-production` (or `deploy-staging`) job, as for the
application: same sha, image re-pulled from GHCR by its sha. The migrations
only go forward: a release older than the newest `drizzle/` cannot read a
newer schema; restore the SQLite file from a copy in that case.

**Back to classroom's portal** (the switch itself fails):

```bash
gh variable set CODESPACE_DEPLOY --env production --repo heig-tin-info/heig-quiz --body 0   # from the workstation
systemctl stop quiz-codespace-prod.service
rm /etc/containers/systemd/quiz-codespace-prod.container /etc/caddy/conf.d/quiz-codespace-prod.caddy
systemctl daemon-reload
cp /root/classroom-codespace/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
systemctl enable --now codespace-net.service codespace.service codespace-shadow.timer
curl -fsS https://code.chevallier.io/healthz
```

The network, its anchor and the nftables table are compatible with
classroom's (the same `codespace` network; the table only adds `cs1`).
Remove `CODESPACE_URL` from Quiz's `.env.prod` if its workspace links must
not point at classroom's portal. Classroom's portal needs its App key
again only if step 12 already ran, which is why it is the last step.

## Day to day

### The live-session guard

A **prod** deploy refuses (exit 3, the `deploy-production` job fails at its
last step, after the application and the runner) while a session container
of the prod instance is running: a restart keeps the student containers
and the reconciliation resumes them, but every open editor loses its
connection for a few seconds, and an exam must not. Staging is not guarded,
like the application's staging. "Running" is asked of Podman
(`label=heig-codespace.instance=prod`, `status=running`), so a portal that is
down does not block its own repair; a `podman ps` that fails refuses.

When it refuses: wait for the sessions to end (closed, or 10 minutes
without a heartbeat), then *Re-run failed jobs*. To force it:

```bash
gh variable set CODESPACE_FORCE_SHA --repo heig-tin-info/heig-quiz --body <the run's full sha>
# re-run the deploy-production job, then:
gh variable delete CODESPACE_FORCE_SHA --repo heig-tin-info/heig-quiz
```

The job then sends `force codespace prod <sha> <token>`; a forgotten value
forces nothing but that one sha. `DEPLOY_FORCE_SHA` (the application's
guard) does not force this one. By hand on the VM:
`SSH_ORIGINAL_COMMAND="force codespace prod <sha> <token>" /opt/quiz-runner/infra/engine/deploy.sh production`.

### Where to look

```bash
journalctl -u quiz-codespace-prod -n 50 --no-pager      # the portal (pino JSON, token= masked)
tail -n 20 /var/log/caddy/quiz-codespace-prod.log       # access log, token masked
journalctl -u quiz-codespace-shadow@prod -n 5 --no-pager
podman ps --filter label=heig-codespace.instance=prod
```

### Rotating a launch secret

Edit `CODESPACE_LAUNCH_SECRET` in `/etc/quiz-codespace/<instance>/env`, then
`systemctl restart quiz-codespace-<instance>`, and the same value in Quiz's
`.env.prod` (or `.env.staging`) followed by `up -d app`. Between the two, a
launch or a sync fails with a named refusal; nothing is lost.

### Capacity

The VM has 2 vCPU and 3.7 GB: two portals (512 MB cap each), the runner
(512 MB) and student containers at `CODESPACE_MEMORY=1536m` each. Staging
sessions take memory from production's. Resizing, cgroup slices and the
off-VM backup of `/srv/quiz-codespace` are M6-05's.
