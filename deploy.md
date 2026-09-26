# Deployment: two VMs, one CI

Production is `https://quiz.chevallier.io`, deployed the way its sibling
heig-classroom is, on the same machines (ADR-016):

| | `portal.heig.chevallier.io` (Hetzner CPX12, 1 vCPU / 2 GB + 2 GB swap) | `code.chevallier.io` (Hetzner, 2 CPU / 4 GB) |
| --- | --- | --- |
| Already runs | heig-classroom (`:3000`), evaluation-tb (`:3001`), a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/srv/quiz`: `app` (`127.0.0.1:3002`), `postgres`, `backup` — Docker Compose, rootless, as `srv`; and staging, `/srv/quiz-staging` (`127.0.0.1:3003`, §8) | `/opt/quiz-runner`: the runner as a Podman quadlet on `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy` → `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy` → `code.chevallier.io:8443` |
| Deploys through | `/srv/quiz/deploy.sh production` and `/srv/quiz-staging/deploy.sh staging` (forced commands, user `srv`) | `/opt/quiz-runner/apps/runner/deploy/deploy.sh` (forced command) |

Until 2026-09-25 the application VM was a DigitalOcean droplet
(`165.245.246.213`, root, rootful Docker, everything under `/opt`); the three
services moved to the Hetzner VM together, and the directory basenames (hence
the compose project and volume names) did not change.

Neither VM ever builds anything of ours: the two images come from GHCR, built
by CI. The neighbours are not touched — the application VM's Caddy
imports one fragment per service, and the code VM's Caddyfile (owned by
heig-codespace) gained that one `import /etc/caddy/conf.d/*.caddy` line.

## 1. DNS

`quiz.chevallier.io` is a CNAME to `portal.heig.chevallier.io` (A
`128.140.71.35`, AAAA `2a01:4f8:1c19:1164::1`), at Gandi, TTL 300, like
`classroom.chevallier.io` and `tb.chevallier.io`. Caddy obtains the
certificate on its own once it resolves (`dig +short quiz.chevallier.io`). The
runner is reached through the code VM's existing name, `code.chevallier.io`,
on port **8443** — the same certificate, a port of its own so that the
codespace's `:443` site block is not touched. That port must be open in the
Hetzner firewall for the application VM's address.

## 2. The application VM (`/srv/quiz`)

Everything runs as the service account `srv`, which owns `/srv` and runs
**rootless Docker** in its systemd user session (socket
`/run/user/1000/docker.sock`, lingering enabled so the containers restart at
boot; there is no root Docker daemon). A human reaches it with
`sudo machinectl shell srv@`. Its sudo covers exactly two commands,
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and
`systemctl reload caddy`; `/etc/caddy/conf.d/` is group-writable by `srv`.

In rootless Docker, uid 1000 inside a container (`node` in the image) is host
uid 100999, so a host-side `chown 1000:1000` is wrong: ownership the container
must see is set through a container, and a file it owns is read the same way.

```bash
cd /srv && git clone https://github.com/heig-tin-info/heig-quiz.git quiz && cd quiz
mkdir -p secrets backups assets
# edu-ID: the client shares the classroom's public JWK, so the same key and kid.
# The classroom's copy belongs to its container's `node`: read it through a container.
docker run --rm -v /srv/heig-classroom/secrets:/s:ro alpine cat /s/eduid-private-key.pem > secrets/eduid-private-key.pem
docker run --rm -v "$PWD":/w alpine sh -c 'chown -R 1000:1000 /w/secrets /w/backups /w/assets && chmod 600 /w/secrets/*.pem'
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD, COOKIE_SECRET: openssl rand -base64 32
                  # OIDC_CLIENT_ID: from the SWITCH Resource Registry
                  # RUNNER_TOKEN: openssl rand -hex 32 — the SAME value goes to the code VM
cp Caddyfile /etc/caddy/conf.d/quiz.caddy && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

The edu-ID client is registered with the redirect URI
`https://quiz.chevallier.io/app/auth/callback` and authenticates with
`private_key_jwt` (`OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID`). Keycloak is
a development identity provider and is not deployed. `AUTH_DEV_LOGIN` and a
`pglite://` database are both refused by `config.ts` under
`NODE_ENV=production`: setting either in `.env.prod` stops the container from
starting, on purpose. The super administrator is `SUPER_ADMIN_EMAIL`; teachers
are managed from the Admin screen.

An encrypted copy of `.env.prod` and `secrets/` in the vault (`age`) is a
precondition of the 4 h RTO (ADR-010).

## 3. The runner VM (`/opt/quiz-runner`)

```bash
cd /opt && git clone https://github.com/heig-tin-info/heig-quiz.git quiz-runner && cd quiz-runner
install -d -m 0700 /etc/quiz-runner
cp apps/runner/deploy/env.example /etc/quiz-runner/env && chmod 600 /etc/quiz-runner/env
nano /etc/quiz-runner/env      # RUNNER_TOKEN: the value in /srv/quiz/.env.prod on the application VM
# The host Caddyfile belongs to heig-codespace: add ONE line to it, once.
grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile || sed -i '1i import /etc/caddy/conf.d/*.caddy\n' /etc/caddy/Caddyfile
mkdir -p /etc/caddy/conf.d && cp apps/runner/deploy/Caddyfile /etc/caddy/conf.d/quiz-runner.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
# The language images: the runner's only supply chain, built HERE, never pulled.
# `spice` is ngspice, for the `circuit` question type (ADR-019): without it
# `GET /health` does not list `spice` and every circuit grading degrades to a
# PROPOSED grade. It is the default list, so passing no argument builds it.
PODMAN_REMOTE_URL=unix:///run/podman/podman.sock apps/runner/images/build.sh c cpp python js spice
podman images | grep quiz-runner
```

After an upgrade that adds or changes an image (a new language, a new ngspice),
rebuild it on the VM — nothing else does: `deploy.sh` ships the runner's own
image, never the sandbox ones.

The quadlet (`apps/runner/deploy/quiz-runner.container`) is installed by
`deploy.sh` at every deploy: host networking bound to loopback, two read-only
things from the host — the rootful socket and the seccomp profile, installed
at `/etc/quiz-runner/seccomp.json` because the Podman *server* is what opens
it — a read-only root, no capability, `Pull=never` (the image is pulled by
the deploy, with the CI's token, never at boot). The
runner holds one secret, `RUNNER_TOKEN`, checked on both routes; it reaches no
database and passes nothing of its environment into the sandbox containers
(`apps/runner/README.md`).

Caddy answers 403 to any address but the application VM's (`@quiz remote_ip
128.140.71.35` in `apps/runner/deploy/Caddyfile`), and the runner answers 401
to any call without the token: two gates, either one enough. If the
application VM moves again, add its new address to that line — in the
repository and in `/etc/caddy/conf.d/quiz-runner.caddy` on the code VM —
before the switch, as the 2026-09-25 migration did.

## 4. CI → the two VMs (once)

Every push to `main` goes to staging, then waits for an approval before the
SAME sha goes to production (ADR-028, §8). The `deploy-production` job of
`.github/workflows/ci.yml` SSHes to both VMs with one key, pinned to a script
on each (`command="…",restrict`): the key can ONLY deploy, never open a
shell, even if it leaks. The images stay private on GHCR: the runner passes
`<sha> <ephemeral token>` as the SSH "command" (→ `$SSH_ORIGINAL_COMMAND`);
each `deploy.sh` checks out that sha and pipes the token into `docker login` /
`podman login` for the pull — no registry credential is stored on either VM.

```bash
ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@quiz
gh secret set DEPLOY_SSH_KEY --repo heig-tin-info/heig-quiz < ci_deploy          # PRIVATE key, an Actions secret
gh variable set DEPLOY_HOST --repo heig-tin-info/heig-quiz --body classroom.chevallier.io   # a CNAME to the application VM
gh variable set DEPLOY_USER --repo heig-tin-info/heig-quiz --body srv
gh variable set DEPLOY_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 classroom.chevallier.io | awk '{print $2" "$3}')"
gh variable set DEPLOY_RUNNER_HOST --repo heig-tin-info/heig-quiz --body code.chevallier.io
gh variable set DEPLOY_RUNNER_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 code.chevallier.io | awk '{print $2" "$3}')"
# on the application VM, as srv
printf 'command="/srv/quiz/deploy.sh production",restrict %s\n' "$(cat ci_deploy.pub)" >> /home/srv/.ssh/authorized_keys
# on the runner VM
printf 'command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict %s\n' "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
shred -u ci_deploy
```

The application VM carries the previous VM's SSH host keys, copied over, so
`DEPLOY_HOST_KEY` did not change with the 2026-09-25 move. `deploy.sh` enters
its own directory and, when not root, defaults `DOCKER_HOST` to the rootless
socket; its registry login lives in a throwaway `DOCKER_CONFIG`, removed on
exit, because heig-classroom deploys on the same `srv` account and two
concurrent logins in `~/.docker/config.json` overwrote each other ("denied",
2026-09-25).

Without the secret the job skips cleanly (the images are published anyway);
without `DEPLOY_RUNNER_HOST` only the application is deployed.

## 5. First deployment, and every one after

Push to `main`: checks, two images, the staging deploy and its health check,
then the `production` environment waits for an approval (Actions → the run →
*Review deployments*) before two SSH calls. Then:

```bash
curl -s https://quiz.chevallier.io/healthz | jq .              # database, jobs, runner: "up"
ssh srv@portal.heig.chevallier.io 'cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod logs --tail 50 app'
ssh root@code.chevallier.io 'journalctl -u quiz-runner -n 30'   # "podman engine ready", "quiz-runner started"
```

`/healthz` reports the runner `down` when it is unreachable or refuses the
token, and `disabled` when `RUNNER_MODE` is left at `stub`; neither degrades
the platform: a code question stays authorable, playable and releasable, and
its grading is proposed for a manual review (decision D14).

### Manually (if CI is unavailable)

```bash
# application VM, as srv: deploy.sh does the checkout, the login, the pull and
# the restart. "<sha> <PAT>" deploys that commit; "<PAT>" alone, origin/main.
cd /srv/quiz && SSH_ORIGINAL_COMMAND="<sha> <PAT read:packages>" ./deploy.sh production
# runner VM
cd /opt/quiz-runner && SSH_ORIGINAL_COMMAND="<sha> <PAT read:packages>" ./apps/runner/deploy/deploy.sh
```

The checkouts are DETACHED at the deployed commit, and `.env.image` holds its
tag: a manual compose command passes both env files, so that it restarts the
deployed image and not `:latest` (main's head, not yet approved):

```bash
docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image <command>
```

### Rollback

Re-run the `deploy-production` job of the run of the healthy commit (Actions →
that run → *Re-run jobs*): same sha, same image, both VMs. Without CI, the
manual deploy above with that sha. Migrations are additive — when in doubt,
restore the database (§6).

**Never build on the application VM** (1 vCPU, 2 GB): an on-VM build makes
the host swap and strangles PostgreSQL — the classroom learned it on
2026-07-10, on the previous VM — and fills the disk. The runner VM could
build, and does build the small Alpine language images; the runner image
itself still comes from CI so that both VMs run the commit the checks passed
on.

## 6. Backups (RPO 24 h, RTO 4 h)

- **A daily provider backup of the application VM**, off the machine:
  Hetzner Backups (the Backups tab of the server in the Hetzner console, 7
  daily slots), which replaces the previous host's daily snapshot. The whole
  VM comes back, secrets and volumes included, crash-consistent. It must be
  enabled in the console: check that it is.
- **A daily `pg_dump -Fc`** from the compose `backup` service into
  `/srv/quiz/backups/` (30-day retention): a logical dump, restorable table
  by table. It lives on the VM it protects.
- `/srv/quiz/assets/` (question images, content-addressed) is part of what to
  copy: `rsync` is enough.
- The runner VM holds nothing to back up: the language images rebuild in a
  minute from `apps/runner/images/`.
- **Before any migration**, take a fresh dump rather than trusting the daily one:

```bash
cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U quiz quiz > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- Restore a full dump into a freshly recreated database, the app stopped:
  `pg_restore --clean` into the existing one fails on pg-boss's partitioned
  tables (`cannot drop inherited constraint … job_common`), as the
  2026-09-25 migration found.

```bash
cd /srv/quiz && C="docker compose -f compose.prod.yml --env-file .env.prod"
$C stop app
$C exec -T postgres psql -U quiz -d postgres \
  -c 'DROP DATABASE quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
$C exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz --exit-on-error < backups/quiz-<date>.dump
$C start app
```

- **Still to wire**: an off-VM copy of the dumps (`rclone copy backups
  remote:quiz-backups` in cron). VM lost: new VM → §2 → secrets from the
  vault → restore the dump → re-point the DNS. Timed restore test every
  semester.

## 7. Monitoring

An external 60 s probe on `https://quiz.chevallier.io/healthz`; logs through
`docker compose logs -f app` on one VM and `journalctl -u quiz-runner -f` on
the other (credentials masked). `GET /metrics` needs an admin session or
`METRICS_TOKEN`.

## 8. Staging (`quiz.dev.chevallier.io`, ADR-028)

Staging runs on the application VM, next to production, as `srv`: its own
checkout, compose project (`quiz-staging`), PostgreSQL, port (`3003`) and
secrets, every container capped (`compose.staging.yml`). It is production
configured: `NODE_ENV=production`, the edu-ID login, no development login.
Only the addresses in `LOGIN_ALLOWLIST` (and the super administrator) may
sign in, because its data is a copy of production's.

### Once

```bash
# DNS at Gandi: quiz.dev.chevallier.io CNAME portal.heig.chevallier.io, TTL 300.
# SWITCH Resource Registry: add the redirect URI
#   https://quiz.dev.chevallier.io/app/auth/callback   (or register a client of its own)

# On the application VM, as srv. Rootless Docker applies `cpus`/`cpu_shares`
# only when systemd delegates the cpu controller: this must list `cpu`.
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
#   Without it (as root): mkdir -p /etc/systemd/system/user@.service.d && printf \
#     '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf \
#     && systemctl daemon-reload,
#   then restart the srv user session (or reboot).

cd /srv && git clone https://github.com/heig-tin-info/heig-quiz.git quiz-staging && cd quiz-staging
mkdir -p secrets assets
# The production key belongs to its container's `node`: read it through a container.
docker run --rm -v /srv/quiz/secrets:/s:ro alpine cat /s/eduid-private-key.pem > secrets/eduid-private-key.pem
docker run --rm -v "$PWD":/w alpine sh -c 'chown -R 1000:1000 /w/secrets /w/assets && chmod 600 /w/secrets/*.pem'
cp .env.staging.example .env.staging && chmod 600 .env.staging
nano .env.staging   # POSTGRES_PASSWORD, COOKIE_SECRET (new values), OIDC_CLIENT_ID, LOGIN_ALLOWLIST
cp Caddyfile.staging /etc/caddy/conf.d/quiz-staging.caddy && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy

# A second CI key, pinned to staging: the production key never reaches it.
ssh-keygen -t ed25519 -f ci_staging -N "" -C ci-deploy-staging@quiz
gh secret set STAGING_DEPLOY_SSH_KEY --repo heig-tin-info/heig-quiz < ci_staging
printf 'command="/srv/quiz-staging/deploy.sh staging",restrict %s\n' "$(cat ci_staging.pub)" >> /home/srv/.ssh/authorized_keys
shred -u ci_staging

# The approval: Settings → Environments → production → Required reviewers.
# Until it is set, production deploys right after staging, unattended.
```

**The switch from the previous `deploy.sh`** (once, before the first
promotion): the scripts in place still expect a bare token, and the CI now
sends `<sha> <token>`. Move both production checkouts to the new scripts by
hand first — `git -C /srv/quiz fetch && git -C /srv/quiz checkout --detach
origin/main` on the application VM, the same in `/opt/quiz-runner` on the code
VM — and change the production key's line in `authorized_keys` to
`command="/srv/quiz/deploy.sh production"` (the bare form still means
production).

The first staging deploy starts an empty database; fill it with
production's data (below).

### Refreshing the data

```bash
/srv/quiz-staging/scripts/staging-refresh.sh            # last night's dump
/srv/quiz-staging/scripts/staging-refresh.sh --fresh    # a dump taken now
```

Never on deploy: a refresh wipes whatever a test had prepared. It restores
the dump into a recreated database, empties sessions, launch tickets, API
tokens and OAuth grants (nothing production issued works here), copies the
question images, and starts the app, which migrates the copy forward — the
very migration production will run next. It doubles as the restore test of
§6.

### Exam days

Staging shares the vCPU. Stop it for the duration of an exam:

```bash
cd /srv/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image stop
```

A deploy restarts it (`up -d`); so does `start`.
