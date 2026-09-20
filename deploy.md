# Deployment on a single VM

## 1. Create an Ubuntu/Debian VM

```bash
# 2 GB of swap (useful below 2 GB of RAM)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Update + basic tools
apt update && apt upgrade -y
apt install -y curl git ufw gnupg ca-certificates

# Dedicated application user
adduser --system --group --home /opt/quiz quiz

# Firewall: SSH + HTTP + HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

```bash
root@quiz:~# ufw status
Status: active

To                         Action      From
--                         ------      ----
OpenSSH                    ALLOW       Anywhere
80                         ALLOW       Anywhere
443                        ALLOW       Anywhere
OpenSSH (v6)               ALLOW       Anywhere (v6)
80 (v6)                    ALLOW       Anywhere (v6)
443 (v6)                   ALLOW       Anywhere (v6)
```

No Node.js and no pnpm on the VM: the application only ever runs as a container built in CI
(see §7), so Docker and Caddy are all that is installed.

```bash
# Docker + compose plugin (official repository)
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Caddy (reverse proxy + automatic TLS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

```
root@quiz:~# docker --version
Docker version 29.6.1, build 8900f1d
root@quiz:~# caddy version
v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=
```

## 2. DNS: `quiz.example.ch` → the VM's IP (A/AAAA), propagation checked
(`dig +short quiz.example.ch`).

## 3. Code and secrets

```bash
cd /opt/quiz
sudo -u quiz git clone <repository-url> app && cd app
mkdir -p secrets backups
# Drop in (never in git), then chmod 600:
#   secrets/eduid-private-key.pem   (private_key_jwt for Switch edu-ID)
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD/COOKIE_SECRET: openssl rand -base64 32
```

An encrypted copy of the secrets in the vault (`age`) is a precondition of the 4 h RTO
(ADR-010).

## 4. Caddy (native): the vhost is versioned in [Caddyfile](Caddyfile)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## 5. First deployment

The image is **never built on the VM**: it is built in CI and pulled from GHCR (§7), so the
first start is a pull followed by an `up -d`, exactly like every later deployment. Log in to
GHCR first if the package is still private (see the manual deployment in §7).

```bash
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
docker compose -f compose.prod.yml logs -f app   # migrations, then "quiz-server started"
curl -s https://quiz.example.ch/healthz  # {"status":"ok",...}
```

This starts the `app`, `postgres` and `backup` services — and only those. Keycloak is a
DEVELOPMENT identity provider and is not deployed here; production authenticates against
Switch edu-ID. The development persona picker (`AUTH_DEV_LOGIN`) and the embedded pglite
database are both REFUSED by `config.ts` under `NODE_ENV=production`: setting either of them
in `.env.prod` stops the container from starting, on purpose.

The super administrator is `SUPER_ADMIN_EMAIL`; teachers are managed from the Admin screen.

## 5b. The runner (code execution)

The `runner` service of `compose.prod.yml` executes student code. It contains no engine of
its own: it drives the **host's rootful Podman** through the socket it mounts, and the
containers it starts are the hardened ones (`apps/runner/README.md` has the flag list). It is
on the internal compose network only — never published, never behind Caddy — and holds no
secret, no database access and no credential.

```bash
# On the VM, once. Rootful Podman: the socket is root-owned, which is why the
# runner container is the only one that gets to see it.
sudo apt-get install -y podman
sudo systemctl enable --now podman.socket      # /run/podman/podman.sock

# The language images, built ON THE VM but NOT from a Dockerfile of ours: they
# are three `apk add` on Alpine, a few seconds each, and no Node build.
sudo -u root env PODMAN_REMOTE_URL=unix:///run/podman/podman.sock \
  /opt/quiz/apps/runner/images/build.sh c cpp python js

sudo podman images | grep quiz-runner          # c, cpp, python, js
```

Then bring the stack up as usual. Checks:

```bash
docker compose -f compose.prod.yml exec app curl -sf http://runner:3200/health
curl -sf https://quiz.example.ch/healthz | jq .checks.runner     # "up"
```

`/healthz` reports `disabled` when `RUNNER_MODE` is left at `stub`, `down` when the service
is unreachable, and neither of those degrades the platform: a code question stays authorable,
playable and releasable, and its grading is proposed for a manual review (decision D14). So a
VM where Podman is not installed yet runs the whole platform minus the automatic grading of
code — remove `RUNNER_MODE`/`RUNNER_URL` from the `app` service and drop the `runner` service.

**The images are the runner's only supply chain.** They are built from
`apps/runner/images/*/Containerfile` on the VM, never pulled from a registry: the runner has
no registry credential and the sandbox containers have no network at all.

## 6. Update / rollback

Deployment is done by CI (`.github/workflows/ci.yml`): every push to `main` passes the
checks, builds the two images on GitHub Actions, pushes them to GHCR
(`ghcr.io/heig-tin-info/quiz` and `ghcr.io/heig-tin-info/quiz-runner`, tags `latest` + sha), and then the `deploy` job
connects to the VM over SSH and triggers `deploy.sh` (image pull + `up -d`) — a few seconds,
zero contention.

**Never build on the VM** (453 MiB / 1 CPU): a local build makes the host swap and strangles
Postgres — `Connection terminated` timeouts on login/ticker/pg-boss, experienced on
2026-07-10 — and fills the disk (~1 GB of builder cache per cycle).

### Security of the CI → VM access (forced command)

The CI key is pinned to `deploy.sh` in `authorized_keys`: with that key the runner can
**only** deploy, never open a shell (even if the secret leaks). The GHCR package stays
private: the runner passes its ephemeral token as the SSH "command" (→
`$SSH_ORIGINAL_COMMAND`), which `deploy.sh` uses for the `docker login` for the duration of
the pull — no registry credential is stored on the VM.

### Setup (once)

1. Generate a dedicated key pair:
   ```bash
   ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@quiz
   ```
2. **Private** key → **Actions secret** (⚠ not a Deploy Key):
   ```bash
   gh secret set DEPLOY_SSH_KEY --repo heig-tin-info/quiz < ci_deploy
   ```
3. **Public** key → the VM's `authorized_keys`, pinned to `deploy.sh`:
   ```bash
   # on the VM
   printf 'command="/opt/quiz/deploy.sh",restrict %s\n' \
     "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
   ```
   (`deploy.sh` arrives through `git pull`; it is versioned and already executable.)

Without the secret, the `deploy` job skips cleanly (the image is published to GHCR anyway).

### Manual deployment (if CI is unavailable)

```bash
cd /opt/quiz && git pull --ff-only
echo <PAT read:packages> | docker login ghcr.io -u heig-tin-info --password-stdin
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

### Rollback

The sha tags stay on GHCR:

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml \
  --env-file .env.prod up -d
# additive migrations — when in doubt, restore the database (§8).
```

## 7. Backups (NFR-16: RPO 24 h, RTO 4 h)

Two complementary layers:

- **A daily provider snapshot of the VM**, taken off the machine. It
  covers losing the machine outright: the whole VM comes back, secrets and
  volumes included. It is a disk image of a *running* Postgres, so it is
  crash-consistent — Postgres replays its WAL on the way up. That is sound, but
  it is not the equivalent of a clean dump, and the granularity is the day.
- **A daily `pg_dump -Fc`** from the compose `backup` service into `./backups/`
  (30-day retention). A logical dump, restorable table by table: the right tool
  for backing out of a migration or recovering precise data. It lives **on the
  VM it protects**, so if the machine is lost it is the provider snapshot that saves
  you.
- **Before any migration**, take a fresh dump rather than trusting the daily one:

```bash
cd /opt/quiz && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U quiz quiz > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- **Still to wire**, for a logical dump off the VM: `rclone copy backups
  remote:quiz-backups` in cron (Hetzner object storage, SWITCH storage, etc.). The
  provider snapshot already covers the machine-loss case, so this is no longer a
  gaping hole — but restoring a single table out of a snapshot stays laborious.
- Restore:

```bash
docker compose -f compose.prod.yml stop app
docker compose -f compose.prod.yml exec -T postgres \
  pg_restore -U quiz -d quiz --clean --if-exists < backups/quiz-<date>.dump
docker compose -f compose.prod.yml start app
```

- VM lost: new VM → §1 → secrets from the vault → restore the dump → re-point the
  DNS. Timed restore test every semester.

## 8. SWITCH edu-ID switchover (as soon as the resource is approved) — in `.env.prod`:

```bash
OIDC_ISSUER=<edu-ID issuer>
OIDC_CLIENT_ID=<issued client id>
OIDC_PRIVATE_KEY_PATH=secrets/eduid-private-key.pem
OIDC_PRIVATE_KEY_KID=quiz-eduid-2026
```

`docker compose -f compose.prod.yml --env-file .env.prod up -d app`, then test a real login.

## 9. Monitoring: an external 60 s probe on `/healthz` (Uptime-Kuma, or the hosting provider's own monitor); logs through `docker compose logs -f app` (credentials masked).
