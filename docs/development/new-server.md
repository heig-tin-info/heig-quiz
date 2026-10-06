# Installing the platform on a new Ubuntu server

This page takes a fresh Ubuntu LTS virtual machine to a running Quiz, the
way the current deployment works: one **application VM** (Caddy, the
`app`, PostgreSQL and backup containers on rootless Docker) and, optionally,
one **runner VM** for code questions. It strings together what the
[deployment runbook](deployment.md) describes piece by piece; each step
links the section that owns the details. Nothing is built on the server:
the images come from CI, through GHCR.

Questions this repository does not answer are marked **TODO (product
owner)**; they are collected at the end.

## 0. Before you start

- A VM with Ubuntu LTS, a public IPv4 (and IPv6), SSH access as an
  administrator with sudo. Production today is a Hetzner CPX12 (1 vCPU,
  2 GB + 2 GB swap) shared with two other services
  ([the two machines](deployment.md#the-two-machines)).
  **TODO (product owner)**: the Ubuntu release the current VMs run, how the
  2 GB swap was created, and the base hardening applied (unattended
  upgrades, SSH configuration, the Hetzner firewall rules of the
  application VM: 22, 80 and 443 assumed).
- A DNS name for the instance, a CNAME or A/AAAA record pointing at the VM
  ([deployment §1](deployment.md#1-dns)). Caddy obtains the certificate
  itself once the name resolves.
- An edu-ID client in the SWITCH Resource Registry, with the redirect URI
  `https://<host>/app/auth/callback` and `private_key_jwt` authentication.
  Today's client shares heig-classroom's public JWK, hence its private key
  and `kid` (`hgc-eduid-2026`).
  **TODO (product owner)**: how a new instance gets its own client and key
  pair (key generation, JWK registration, the `kid`), since the repository
  only documents reusing classroom's.
- Read access to the private image `ghcr.io/heig-tin-info/quiz`: CI deploys
  with an ephemeral token; a first deploy by hand needs a personal access
  token with `read:packages`.

## 1. Packages

On the application VM, as an administrator: git, curl, jq, the native
Caddy package and Docker with its rootless extras. Caddy and Docker come
from their vendors' apt repositories (Caddy's "Debian, Ubuntu, Raspbian"
instructions; Docker's "Install Docker Engine on Ubuntu"):

```bash
sudo apt-get update && sudo apt-get install -y git curl jq uidmap dbus-user-session
# Caddy: its official apt repository, then
sudo apt-get install -y caddy
# Docker Engine: its official apt repository, then
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras
# There is no root Docker daemon (deployment §2): every service runs its own rootless one.
sudo systemctl disable --now docker.service docker.socket
```

**TODO (product owner)**: confirm these are the packages and repositories
used on the Hetzner VM (the runbook names the native Caddy and rootless
Docker, not how they were installed).

## 2. The service account and Caddy

Production runs as `srv`, which owns `/srv` and runs rootless Docker in its
systemd user session, lingering so that the containers restart at boot
([the `srv` account](deployment.md#the-srv-account)):

```bash
sudo useradd --create-home --shell /bin/bash srv
sudo install -d -o srv -g srv /srv
sudo loginctl enable-linger srv
# Caddy imports one fragment per service; srv may write the directory.
sudo install -d -g srv -m 2775 /etc/caddy/conf.d
grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/conf.d/*.caddy' | sudo tee /etc/caddy/Caddyfile
# srv's sudo covers exactly two commands (deployment §2).
echo 'srv ALL=(root) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile, /usr/bin/systemctl reload caddy' \
  | sudo tee /etc/sudoers.d/srv-caddy && sudo chmod 440 /etc/sudoers.d/srv-caddy
```

The `tee` above replaces the default Caddyfile of a fresh install: on a VM
that already serves other sites, add the `import` line instead. The
sudoers line is written from the runbook's description; **TODO (product
owner)**: confirm it matches the file on the current VM.

Then, as `srv` (`sudo machinectl shell srv@`), its own rootless Docker:

```bash
dockerd-rootless-setuptool.sh install      # socket /run/user/$(id -u)/docker.sock
echo 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock' >> ~/.bashrc
```

Rootless Docker applies the CPU caps of `compose.staging.yml` only when
systemd delegates the `cpu` controller; the check and the fix are in
[deployment §8](deployment.md#setting-up-staging-once).

## 3. The checkout, the secrets and `.env.prod`

As `srv`, exactly as [deployment §2](deployment.md#setting-up-the-application-vm)
does it:

```bash
cd /srv && git clone https://github.com/heig-tin-info/heig-quiz.git quiz && cd quiz
mkdir -p secrets backups assets backup-status && chmod 755 backup-status
# The edu-ID private key, from the vault (ADR-010), as secrets/eduid-private-key.pem; then
# hand secrets/, backups/ and assets/ to the container's `node` (uid 1000 inside = a sub-uid outside):
docker run --rm -v "$PWD":/w alpine sh -c 'chown -R 1000:1000 /w/secrets /w/backups /w/assets && chmod 600 /w/secrets/*.pem'
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod
```

In `.env.prod` ([the configuration reference](deployment.md#10-configuration-reference)):
`POSTGRES_PASSWORD` and `COOKIE_SECRET` (`openssl rand -base64 32`),
`SUPER_ADMIN_EMAIL`, `OIDC_CLIENT_ID`, the key path and `kid`, the runner
(next step), and, when wanted, the e-mail (`SCW_*`), Teams and LLM
variables. `config.ts` refuses to start on a development login, a PGlite
database, the stub LLM or a placeholder secret: that refusal is the check.

PostgreSQL is not installed on the host: it is the `postgres` container of
`compose.prod.yml` (PostgreSQL 17, the `pgdata` volume, tuned for the small
VM), with the daily `backup` container beside it. Keycloak is a development
identity provider and is never deployed.

**A host name other than `quiz.chevallier.io`** appears in two committed
files: `Caddyfile` (the site address) and `compose.prod.yml` (`PUBLIC_URL`),
with port `3002`, chosen because the VM's neighbours hold 3000 and 3001.
**TODO (product owner)**: for a second instance, edit them in a fork or
branch, or should they become variables of `.env.prod`?

## 4. The runner (code questions)

Either start without it, `RUNNER_MODE=stub` (code questions stay playable;
their grading is proposed for review, `/healthz` reports the runner
`disabled`, see [without the runner](deployment.md#without-the-runner)), or
set up the runner VM as [deployment §3](deployment.md#3-the-runner-vm-optquiz-runner)
describes: rootful Podman, the quadlet, the seccomp profile, its Caddy site
on `:8443` admitting the application VM's address only, the language images
built there, and the same `RUNNER_TOKEN` (`openssl rand -hex 32`) in
`/etc/quiz-runner/env` and in `.env.prod` with `RUNNER_MODE=http` and
`RUNNER_URL`.

## 5. Caddy and TLS

As `srv`:

```bash
cd /srv/quiz && cp Caddyfile /etc/caddy/conf.d/quiz.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

The fragment proxies to `localhost:3002`, streams `/app/api/events`
unbuffered and sets the transport headers; the application sends its own
CSP ([deployment §2](deployment.md#2-the-application-vm-srvquiz)).

## 6. First deploy

The first deploy is the manual one ([deployment §5](deployment.md#manually-if-ci-is-unavailable)),
as `srv`: `deploy.sh` logs in to GHCR with the token, moves the checkout to
the commit, pulls the image tagged with it and starts the stack. The guard
against live evaluations is skipped on a first deploy (no `.env.image`
yet).

```bash
cd /srv/quiz && SSH_ORIGINAL_COMMAND="<PAT read:packages>" ./deploy.sh production   # origin/main's head
```

The image applies the migrations at start (`MIGRATE_ON_START=1`) and serves
the SPA. Then the CI keys, so that the next push deploys by itself, with
the approval of the `production` environment
([setting up the CI keys](deployment.md#setting-up-the-ci-keys)).

**Do not seed** a real instance: `pnpm seed` writes the development demo
world. The super administrator signs in through edu-ID with
`SUPER_ADMIN_EMAIL` and adds the teachers from *Administration*.

## 7. Check it

```bash
curl -s https://<host>/healthz | jq .   # 200, "database": "up", "jobs": "up", runner "up" or "disabled"
docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image logs --tail 50 app
cat backup-status/last.json             # after the first dump: "ok": true
```

Then sign in as the super administrator and open *Administration → System
status*. `pnpm smoke` is NOT for a real instance: it needs the development
login, which production refuses. Set up the external probe on `/healthz`
([deployment §7](deployment.md#7-monitoring)) and check that the provider's
daily VM backup is enabled ([deployment §6](deployment.md#6-backups-rpo-24-h-rto-4-h));
the off-VM copy of the dumps is still to wire (open question 10 of the
specification).

## 8. The GitHub App

Last, and optional: create the instance's own App with `pnpm github:app`
from a workstation, install its key and its six `GITHUB_*` lines, restart
`app`, and install the App on the organizations: the whole procedure is
[Quiz's GitHub App](github-app.md). Without it, every GitHub feature is off
and the rest of the platform runs.

## 9. Staging on the same VM

A staging environment beside it, under its own account `srvstg`, with its
own App on a test organization, is [deployment §8](deployment.md#8-staging-quizdevchevallierio-adr-028)
and [the staging App](github-app.md#staging-heig-quiz-staging).

## Open questions for the product owner

1. The Ubuntu release of the current VMs, the creation of their swap, and
   their base hardening (unattended upgrades, SSH, the application VM's
   firewall rules).
2. The exact packages and apt repositories used for Caddy and Docker.
3. The `srv` sudoers file: is it the line given in step 2?
4. A new instance's own edu-ID client and key pair: how the key and its JWK
   are generated and registered, and which `kid` to use.
5. The host name and port committed in `Caddyfile` and `compose.prod.yml`:
   edit per instance, or turn them into variables?
6. The e-mail sender of a new instance (Scaleway project, sender domain and
   its DNS records), today heig-classroom's.
