# Deployment

This page is the operator's runbook: the shape of the deployment, the exact
commands for the two machines, and what to do on a bad day. The root
`deploy.md` only points here. Its section numbers (§1 to §8) are kept on
purpose, because comments in the scripts and compose files cite them.

Production is `https://quiz.chevallier.io` and staging is
`https://quiz.dev.chevallier.io` (§8). They run on two virtual machines and
come from one repository
([ADR-016](../adr/ADR-016-runner-sur-vm-separee.md),
[ADR-028](../adr/ADR-028-recette-sur-la-meme-vm.md)). The application stack
runs on the VM that already hosts heig-classroom, behind that VM's native
Caddy. The code runner runs on the codespace VM, `code.chevallier.io`, behind
that VM's native Caddy, and the API reaches it over HTTPS with a shared
token. Both images are built on GitHub Actions and pulled from GHCR. Nothing
of ours is ever built on either VM.

The specification's [5.9 Deployment](../spec/05-architecture.md#59-deployment)
describes the earlier single-VM layout and carries an amendment pointing at
ADR-016.

## The two machines

| | `portal.heig.chevallier.io` (application VM) | `code.chevallier.io` (runner VM) |
| --- | --- | --- |
| Size | Hetzner CPX12, 1 vCPU, 2 GB + 2 GB swap, `128.140.71.35` | Hetzner, 2 CPU, 4 GB |
| Already runs | heig-classroom on `:3000`, evaluation-tb on `:3001`, a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/srv/quiz`: the compose stack `app`, `postgres`, `backup`, on the `srv` account's rootless Docker; and staging, `/srv/quiz-staging` (§8) | `/opt/quiz-runner`: the runner as a Podman quadlet |
| Listens on | `app` on `127.0.0.1:3002` (staging `127.0.0.1:3003`) | the runner on `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy` → `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy` → `code.chevallier.io:8443` |
| Deploys through | `/srv/quiz/deploy.sh production` and `/srv/quiz-staging/deploy.sh staging`, forced commands, user `srv` | `/opt/quiz-runner/apps/runner/deploy/deploy.sh`, forced command |

Until 2026-09-25 the application VM was a DigitalOcean droplet
(`165.245.246.213`, root, rootful Docker, everything under `/opt`); the three
services moved to the Hetzner VM together, and the directory basenames (hence
the compose project and volume names) did not change.

Why two: the application VM has no Podman and no room for student
compilations next to two PostgreSQL servers and three Node processes, while
the codespace VM already runs the rootful Podman the runner was written
against. The neighbours are not touched. The application VM's Caddy imports
one fragment per service from `/etc/caddy/conf.d/`; the code VM's
`/etc/caddy/Caddyfile`, owned by heig-codespace, gained that one
`import /etc/caddy/conf.d/*.caddy` line and nothing else.

## 1. DNS

`quiz.chevallier.io` is a CNAME to `portal.heig.chevallier.io` (A
`128.140.71.35`, AAAA `2a01:4f8:1c19:1164::1`), at Gandi, TTL 300, like
`classroom.chevallier.io` and `tb.chevallier.io`. Caddy obtains the
certificate on its own once it resolves (`dig +short quiz.chevallier.io`).

The runner is reached through the code VM's existing name,
`code.chevallier.io`, on port **8443**: the same certificate, a port of its
own so that the codespace's `:443` site block is not touched. No record and no
certificate are added. That port must be open in the Hetzner firewall for the
application VM's address only.

## 2. The application VM (`/srv/quiz`)

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, ports 80 and 443, shared with the neighbours | `Caddyfile`, copied to `/etc/caddy/conf.d/quiz.caddy` |
| `app` | container, published on `127.0.0.1:3002` only | `Dockerfile`, image `ghcr.io/heig-tin-info/quiz` |
| `postgres` | container, PostgreSQL 17, volume `pgdata` | `compose.prod.yml` |
| `backup` | container running a daily `pg_dump -Fc` into `./backups/` | `compose.prod.yml` |

`compose.prod.yml` starts these three containers and only those. The runner
is not in the file. Keycloak is a development identity provider and is not
deployed; production authenticates against Switch edu-ID with the same
private key and `kid` as heig-classroom, since the edu-ID client shares the
classroom's public JWK.

The `postgres` service carries the same low-memory tuning as the classroom's
(`shared_buffers=32MB`, `max_connections=40`, no parallel query): the VM has
one vCPU and 2 GB, shared by three services and two PostgreSQL instances.

The Caddy fragment does two things beyond proxying to `localhost:3002`: it
sets the security headers (HSTS, `nosniff`, referrer policy) and it proxies
`/app/api/events` with `flush_interval -1`, so the server-sent event stream
([ADR-005](../adr/ADR-005-sse-sans-websocket.md)) is never buffered.

### The `srv` account

Everything runs as the service account `srv`, which owns `/srv` and runs
**rootless Docker** in its systemd user session (socket
`/run/user/1000/docker.sock`, lingering enabled so the containers restart at
boot; there is no root Docker daemon). A human reaches it with
`sudo machinectl shell srv@`. Its sudo covers exactly two commands,
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and
`systemctl reload caddy`; `/etc/caddy/conf.d/` is group-writable by `srv`.

In rootless Docker, uid 1000 inside a container (`node` in the image) is host
uid 100999, so a host-side `chown 1000:1000` is wrong: ownership the
container must see is set through a container, and a file it owns is read
the same way.

### Setting up the application VM

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
`private_key_jwt` (`OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID`).
`AUTH_DEV_LOGIN` and a `pglite://` database are both refused by `config.ts`
under `NODE_ENV=production`: setting either in `.env.prod` stops the
container from starting, on purpose. The super administrator is
`SUPER_ADMIN_EMAIL`; teachers are managed from the Admin screen.

Notifications ([ADR-030](../adr/ADR-030-canaux-de-notification.md)):
e-mails go out through Scaleway TEM once `SCW_SECRET_KEY` and
`SCW_DEFAULT_PROJECT_ID` are set in `.env.prod` (the classroom's project and
sender domain; without them every e-mail is only logged). The Microsoft Teams
channel stays off until the Azure Bot and its Entra application exist and
`TEAMS_CLIENT_ID` and `TEAMS_CLIENT_SECRET` (plus `TEAMS_ALLOWED_TENANTS`,
HEIG-VD's tenant, and `TEAMS_BOT_TENANT` for a single-tenant bot) are set:
the whole setup, the secret's rotation included, is
[Microsoft Teams setup](teams.md). Staging sets neither.

An encrypted copy of `.env.prod` and `secrets/` in the vault (`age`) is a
precondition of the 4 h RTO ([ADR-010](../adr/ADR-010-stockage-secrets.md)).

## 3. The runner VM (`/opt/quiz-runner`)

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, owned by heig-codespace; our site block on `:8443` | `apps/runner/deploy/Caddyfile`, installed as `/etc/caddy/conf.d/quiz-runner.caddy` |
| `quiz-runner` | Podman quadlet, `systemd` service `quiz-runner.service` | `apps/runner/deploy/quiz-runner.container`, installed in `/etc/containers/systemd/` |
| the runner image | `ghcr.io/heig-tin-info/quiz-runner`, pulled by the deploy | `apps/runner/Dockerfile` |
| the seccomp profile | `/etc/quiz-runner/seccomp.json` on the host | `apps/runner/infra/seccomp/runner.json`, installed by the deploy |
| the runner's environment | `/etc/quiz-runner/env`, `chmod 600` | `apps/runner/deploy/env.example` |
| the language images | built on the VM through the rootful socket | `apps/runner/images/build.sh` |

`quiz-runner.container` is a Podman quadlet: `systemd` generates
`quiz-runner.service` from it at `daemon-reload`, and `deploy.sh` installs it
at every deploy. The unit runs the CI image with host networking,
`HOST=127.0.0.1` and `PORT=3200`, so the service is reachable from the host's
loopback only and Caddy is the single way in. Two things come from the host:
the rootful socket `/run/podman/podman.sock` (mounted as is, since the
service must write to it) and the seccomp profile (read-only). The service itself has a read-only root, a tmpfs on `/tmp`, no
capability, `NoNewPrivileges` and a 512 MB memory cap. `Pull=never`: the
image is pulled by the deploy script with the CI's token, never at boot.

The seccomp profile is installed on the host on purpose. The runner drives
Podman as a `--remote` client, so `--security-opt seccomp=<path>` names a
file the Podman *server* opens. The deploy copies the repository's profile to
`/etc/quiz-runner/seccomp.json`; the quadlet mounts that same path read-only
into the service and sets `RUNNER_SECCOMP` to it, so the service's startup
check sees the file the server will use.

The Caddy site block `https://code.chevallier.io:8443` reuses the certificate
Caddy already holds for that name, sets HSTS and `nosniff`, and proxies to
`127.0.0.1:3200` for one source address, the application VM's
(`@quiz remote_ip 128.140.71.35` in `apps/runner/deploy/Caddyfile`); every
other address gets a 403. The runner then requires
`Authorization: Bearer <RUNNER_TOKEN>` on `POST /run` and on `GET /health`,
compared in constant time, and answers 401 otherwise. Two gates, either one
enough on its own. `/health` is guarded on purpose: a token the API got wrong
shows up as a runner `down` in `/healthz`, not as one that says `up` and
refuses every run. If the application VM moves again, add its new address to
that line (in the repository and in `/etc/caddy/conf.d/quiz-runner.caddy` on
the code VM) before the switch, as the 2026-09-25 migration did.

The runner holds one secret, that token, and nothing else: it reaches no
database and passes none of its environment into the sandbox containers. The
hardening of the sandbox containers themselves (the flag list, the closed
environment, nothing mounted) is documented once, in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md).
`--userns=auto` is always available on a rootful engine, hence
`RUNNER_USERNS_AUTO=true` in the environment file.

### Setting up the runner VM

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
# PROPOSED grade. It is in the default list, so passing no argument builds it.
PODMAN_REMOTE_URL=unix:///run/podman/podman.sock apps/runner/images/build.sh c cpp python js spice
podman images | grep quiz-runner
```

After an upgrade that adds or changes an image (a new language, a new
ngspice), rebuild it on the VM; nothing else does: `deploy.sh` ships the
runner's own image, never the sandbox ones.

## 4. Continuous deployment

`.github/workflows/ci.yml` has four jobs:

1. **checks**: `pnpm build`, `pnpm typecheck`, `pnpm test` and the runner's
   unit suite, on every push and pull request.
2. **image**, on a push to `main` only: both images are built with
   `docker/build-push-action` and pushed to GHCR twice each, as `:latest` and
   as `:<commit sha>`.
3. **deploy-staging**: one SSH call to the application VM with the
   `STAGING_DEPLOY_SSH_KEY` key, then a wait of up to 150 s for
   `https://quiz.dev.chevallier.io/healthz` to answer 200. A staging that
   does not come up healthy (a migration that fails on production-shaped
   data, a crash at boot) stops the promotion.
4. **deploy-production**, in the `production` environment: it waits for a
   required reviewer's approval (Actions → the run → *Review deployments*),
   then deploys the SAME sha with the `DEPLOY_SSH_KEY` key, one SSH call per
   VM.

Each deploy job has its own concurrency group. Without its key a job prints
a notice and does nothing, so the pipeline stays green until the keys are
provisioned; without `DEPLOY_RUNNER_HOST` only the application is deployed.

### Forced commands

Each VM's `authorized_keys` pins a CI key to a script, with a forced command
and `restrict`:

```text
# /home/srv/.ssh/authorized_keys on the application VM
command="/srv/quiz/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/srv/quiz-staging/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
# /root/.ssh/authorized_keys on the runner VM
command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy@quiz
```

Whatever command the client asks for, the server runs the pinned script
instead, so a key can only deploy and never open a shell, even if it leaks,
and the staging key can never touch production. The workflow connects as
`${{ vars.DEPLOY_USER || 'srv' }}` to the application VM and as `root` to the
runner VM.

The CI sends `<commit sha> <ephemeral GHCR token>` as the SSH command; it
arrives in `$SSH_ORIGINAL_COMMAND`, is matched strictly and never evaluated.
The token is piped straight to `docker login` or `podman login` with
`--password-stdin` and expires with the workflow run; no registry credential
is stored on either VM. On the application VM the login goes to a throwaway
`DOCKER_CONFIG`, removed on exit, because heig-classroom deploys on the same
`srv` account and two concurrent logins in the shared
`~/.docker/config.json` overwrote each other ("denied", 2026-09-25). On the
runner VM, root's Podman auth file lives under `/run`, so nothing survives a
reboot.

### What the two scripts do

Both move their checkout to the deployed sha with
`git checkout --detach <sha>` (a token alone, a manual deploy, deploys the
head of `origin/main`, still by its sha). That rewrites the script while bash
is still reading the old copy, so a deploy that changes the deploy steps
would run the previous ones: each script compares `HEAD` before and after
and, when it moved, hands over to the new copy exactly once (`exec "$0"` with
`QUIZ_DEPLOY_REEXEC=1` set and the token cleared, the login being already
done). Then they diverge:

- **application VM** (`deploy.sh`): serialise with the other environment
  through a `flock` (staging and production share one Docker daemon), write
  the sha to `.env.image` as `IMAGE_TAG`, `docker compose pull app` (only our
  image; `--ignore-pull-failures` is deliberately not used, a missing image
  must stop the deploy rather than half-restart the stack), `up -d`, remove
  the older sha-tagged images, print the deployed commit. When not root it
  defaults `DOCKER_HOST` to the rootless socket.
- **runner VM** (`apps/runner/deploy/deploy.sh`): `podman pull` of the
  sha-tagged runner image and retag it `:latest` (the tag the quadlet runs),
  install the seccomp profile, the quadlet and the Caddy fragment from the
  checkout, `caddy validate`, `systemctl daemon-reload`, restart
  `quiz-runner.service`, reload Caddy, remove the older images, print the
  deployed commit.

`.github/workflows/image-artifact.yml` is a keyless fallback for the
application image only: run by hand, it builds the image and publishes it as
a workflow artifact to `gh run download` and `docker load` on the VM.

### Setting up the CI keys

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

The staging key is set up in §8. The application VM carries the previous
VM's SSH host keys, copied over, so `DEPLOY_HOST_KEY` did not change with the
2026-09-25 move.

## 5. Deploying, and rolling back

Push to `main`: checks, two images, the staging deploy and its health check,
then the `production` environment waits for an approval before the two SSH
calls. Then:

```bash
curl -s https://quiz.chevallier.io/healthz | jq .              # database, jobs, runner: "up"
ssh srv@portal.heig.chevallier.io 'cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image logs --tail 50 app'
ssh root@code.chevallier.io 'journalctl -u quiz-runner -n 30'   # "podman engine ready", "quiz-runner started"
```

`/healthz` reports the runner `down` when it is unreachable or refuses the
token, and `disabled` when `RUNNER_MODE` is left at `stub`; neither degrades
the platform (see *Without the runner* in §10).

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

Re-run the `deploy-production` job of the run of the healthy commit (Actions
→ that run → *Re-run jobs*): same sha, same image, both VMs. Without CI, the
manual deploy above with that sha. The sha tags stay on GHCR, so every past
commit remains deployable.

Most migrations are additive, so an older image runs against a newer
schema. Two are not: `0008_schema_audit.sql` (drops `enrollments.status` and
three unused tables) and `0022_teams_uploaded_app.sql` (drops `teams_links`).
A rollback to an image older than either needs that migration's
pre-migration dump restored first (§6); when in doubt, restore it anyway. A rollback holds until
the next approved promotion.

!!! warning "Never build on the application VM"

    The application VM is small (1 vCPU, 2 GB). A local build makes the host
    swap and strangles PostgreSQL (the classroom learned it on 2026-07-10, on
    the previous VM) and fills the disk with builder cache. `deploy.sh` only
    pulls. The runner VM does build the small Alpine language images, on
    purpose; the runner image itself still comes from CI, so that both VMs
    run the commit the checks passed on.

## 6. Backups (RPO 24 h, RTO 4 h)

- **A daily provider backup of the application VM**, off the machine:
  Hetzner Backups (the Backups tab of the server in the Hetzner console, 7
  daily slots), which replaces the previous host's daily snapshot. The whole
  VM comes back, secrets and volumes included, crash-consistent. It must be
  enabled in the console: check that it is.
- **A daily `pg_dump -Fc`** from the compose `backup` service into
  `/srv/quiz/backups/quiz-<date>.dump` (30-day retention): a logical dump,
  restorable table by table. It lives on the VM it protects.
- `/srv/quiz/assets/` (question images, content-addressed by sha256) is part
  of what to copy: `rsync` is enough. `./secrets` goes through the vault,
  never through the backup directory.
- The runner VM holds nothing to back up: the language images rebuild in a
  minute from `apps/runner/images/`, and its environment file is one line,
  the token, which the vault copy of `.env.prod` also holds.
- **Before any migration**, take a fresh dump rather than trusting the daily
  one:

```bash
cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U quiz quiz > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- Restore a full dump into a freshly recreated database, the app stopped:
  `pg_restore --clean` into the existing one fails on pg-boss's partitioned
  tables (`cannot drop inherited constraint … job_common`), as the
  2026-09-25 migration found.

```bash
cd /srv/quiz && C="docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image"
$C stop app
$C exec -T postgres psql -U quiz -d postgres \
  -c 'DROP DATABASE quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
$C exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz --exit-on-error < backups/quiz-<date>.dump
$C start app
```

- **Still to wire**: an off-VM copy of the logical dumps (for instance
  `rclone copy backups remote:quiz-backups` in cron; open question 10 of
  `docs/spec/06-questions-ouvertes.md`). VM lost: new VM → §2 → secrets from
  the vault → restore the dump → re-point the DNS. Timed restore test every
  semester; a staging refresh (§8) doubles as one.

In development the equivalent of the database is the directory
`apps/api/.data/pglite`, which is only ever copied to keep a state, never
deployed.

## 7. Monitoring

`GET /healthz` answers `200 {"status":"ok"}` when the database answers
`SELECT 1`, and `503 {"status":"degraded"}` otherwise. Its `checks` object
reports `database`, `jobs` (whether pg-boss is up) and `runner`, which is
`up`, `down` (configured but unreachable, or refusing the token) or
`disabled` (`RUNNER_MODE=stub`). The runner never decides the overall
status: an unreachable runner only degrades code grading, and a container
must not be restarted for that. The container `HEALTHCHECK` and an external
60 s probe on `https://quiz.chevallier.io/healthz` both hit this route.

`GET /metrics` is a Prometheus endpoint with the default collectors and a
`quiz_database_up` gauge. It is never public: a request with
`Authorization: Bearer $METRICS_TOKEN` passes when the token is set, and any
other request must carry an admin session.

Logs are `docker compose logs -f app` on one VM and
`journalctl -u quiz-runner -f` on the other (credentials masked).

## 8. Staging (`quiz.dev.chevallier.io`, ADR-028)

Staging runs on the application VM, next to production, as `srv`: its own
checkout (`/srv/quiz-staging`), compose project (`quiz-staging`),
PostgreSQL, port (`3003`) and secrets, every container capped
(`compose.staging.yml`). It is production configured: `NODE_ENV=production`,
the edu-ID login, no development login. Only the addresses in
`LOGIN_ALLOWLIST` (and the super administrator) may sign in, because its
data is a copy of production's.

### Setting up staging

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
question images, and starts the app, which migrates the copy forward: the
very migration production will run next. It doubles as the restore test of
§6.

### Exam days

Staging shares the vCPU. Stop it for the duration of an exam:

```bash
cd /srv/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image stop
```

A deploy restarts it (`up -d`); so does `start`.

## 9. The two images

`Dockerfile` builds one image for the API and the built SPA together: a
`node:24-slim` build stage installs the workspace with a frozen lockfile,
builds every package sequentially (`--workspace-concurrency=1`), then
`pnpm deploy`s a pruned production tree of `@quiz/api` with the migrations
and `apps/web/dist` alongside. The runtime stage runs as the `node` user
with `STATIC_DIR=/app/web`, `MIGRATE_ON_START=1` and a `HEALTHCHECK` on
`/healthz`. The API applies the migrations at startup, then serves the SPA
from `/app/web`.

The runner image (`apps/runner/Dockerfile`) is smaller and different in one
respect: it contains no container engine, only the static `podman-remote`
client of a pinned version (5.7.0), verified by checksum, and it runs as
root on purpose because the socket it drives is root-owned. The pinned
version must match the engine of the code VM; upgrading the VM's Podman
means bumping the pin.

## 10. Configuration reference

### The application side

The `app` container reads `.env.prod` (from `.env.prod.example`,
`chmod 600`), plus a few values `compose.prod.yml` sets itself:
`NODE_ENV=production`, `DATABASE_URL` built from `POSTGRES_PASSWORD`,
`PUBLIC_URL` and `ASSETS_DIR`. Every variable is validated at startup by
`apps/api/src/config.ts`, which refuses to start on an invalid or dangerous
configuration.

| Variable | Production value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://quiz:<password>@postgres:5432/quiz`, set by compose | a `pglite://` URL is refused under `NODE_ENV=production` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32` | used by the `postgres`, `backup` and `app` services |
| `COOKIE_SECRET` | `openssl rand -base64 32` | signs the login state cookies; the `change-me` placeholder is refused |
| `AUTH_DEV_LOGIN` | unset | `1` is refused: the process does not start |
| `PUBLIC_URL` | `https://quiz.chevallier.io`, set by compose | base of the OIDC redirect URI; `WEB_URL` is left empty because the monolith serves the SPA itself |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | `https://login.eduid.ch/` and the client id from the SWITCH Resource Registry | the dev defaults point at the local Keycloak |
| `OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID` | `secrets/eduid-private-key.pem`, `hgc-eduid-2026` | `private_key_jwt` client authentication: the classroom's key and `kid`, since the client shares its public JWK; `./secrets` is mounted read-only into the container |
| `OIDC_CLIENT_SECRET` | unset | with a private key configured the secret is never sent and is not checked; without one, `client_secret` authentication applies and the `not-for-production` placeholder is refused |
| `SUPER_ADMIN_EMAIL` | one address | the only account managed through the environment; teachers are managed from the admin screen |
| `LOGIN_ALLOWLIST` | unset (staging: the testers' addresses) | when set, only these addresses and the super administrator may sign in |
| `SESSION_TTL_HOURS` | `12` | idle timeout with sliding expiry, at most 720 |
| `TRUSTED_PROXIES` | default `loopback,172.16.0.0/12` | the addresses the API accepts `X-Forwarded-For` from: native Caddy on loopback and the Docker bridge; `req.ip` feeds the room restriction and the attempt journal, so never list a range a student machine can sit on |
| `OAUTH_CIMD_HOSTS` | default `claude.ai,claude.com,chatgpt.com` | the only hosts whose OAuth Client ID Metadata Documents the server fetches ([ADR-023](../adr/ADR-023-serveur-oauth-pour-mcp.md)); `PUBLIC_URL` is the OAuth issuer, so it must be the exact public origin |
| `METRICS_TOKEN` | a bearer token for Prometheus | empty leaves `/metrics` to an admin session; the endpoint is never public |
| `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID` | the classroom's Scaleway project | empty: e-mails are logged, never sent |
| `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_ALLOWED_TENANTS`, `TEAMS_BOT_TENANT` | see [Microsoft Teams setup](teams.md) | empty: the Teams channel is off |
| `RUNNER_MODE`, `RUNNER_URL` | `http`, `https://code.chevallier.io:8443` | `http` without a URL is refused; `stub` disables the runner, see below |
| `RUNNER_TOKEN` | `openssl rand -hex 32`, the same value as `/etc/quiz-runner/env` on the runner VM | sent as `Authorization: Bearer` on every call; required when `RUNNER_MODE=http`, the process does not start without it |
| `RUNNER_TIMEOUT_MS` | default `30000` | wall-clock budget of one runner call |
| `LOG_LEVEL`, `WORKER_MODE` | `info`, `all` | `web`/`worker` would split the roles without a code change ([ADR-001](../adr/ADR-001-monolithe-modulaire.md)) |

The uploaded question images live in `./assets` on the host, mounted at
`/app/assets` (`ASSETS_DIR`); the store is content-addressed by sha256, so a
backup of it is a plain copy.

Secrets travel through the environment or a mounted file and are never in
git ([ADR-010](../adr/ADR-010-stockage-secrets.md)).

### The runner side

The service reads `/etc/quiz-runner/env` (from
`apps/runner/deploy/env.example`, root only, `chmod 600`) through the
quadlet's `EnvironmentFile`, plus what the quadlet sets. Everything is
validated at startup by `apps/runner/src/config.ts`.

| Variable | Production value | Notes |
| --- | --- | --- |
| `RUNNER_TOKEN` | the value in `/srv/quiz/.env.prod` on the application VM | required under `NODE_ENV=production`: the service refuses to start without it; the only secret the runner holds, never passed into a sandbox container |
| `NODE_ENV`, `HOST`, `PORT` | `production`, `127.0.0.1`, `3200`, set by the quadlet | host networking, loopback only |
| `RUNNER_SECCOMP` | `/etc/quiz-runner/seccomp.json`, set by the quadlet | the host path the Podman server opens; a missing file stops the service |
| `PODMAN_SOCKET` | `/run/podman/podman.sock` | the rootful socket, mounted into the service |
| `RUNNER_USERNS_AUTO` | `true` | a rootful engine always supports `--userns=auto`, so no probe |
| `RUNNER_CONCURRENCY`, `RUNNER_QUEUE_MAX` | `2`, `32` | the VM has 2 CPUs and each container is 1 CPU |
| `LOG_LEVEL` | `info` | |

The image itself sets `PODMAN_BIN=podman-remote`.

### Without the runner

Set `RUNNER_MODE=stub` and drop `RUNNER_URL` and `RUNNER_TOKEN`, and the
whole platform still runs: a code question stays authorable, playable and
releasable, `POST /attempts/:id/run` answers `503 runner_unavailable`, and
its grading is proposed for a manual review (PLAN-MVP decision D14).
`/healthz` then reports the runner as `disabled`, a configuration and not a
failure.
