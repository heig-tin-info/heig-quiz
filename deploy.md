# Deployment: two VMs, one CI

Production is `https://quiz.chevallier.io`, deployed the way its sibling
heig-classroom is, on the same machines (ADR-016):

| | `classroom.chevallier.io` (DigitalOcean, 1 CPU / 956 MiB) | `code.chevallier.io` (Hetzner, 2 CPU / 4 GB) |
| --- | --- | --- |
| Already runs | heig-classroom (`:3000`), evaluation-tb (`:3001`), a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/opt/quiz`: `app` (`127.0.0.1:3002`), `postgres`, `backup` — Docker Compose | `/opt/quiz-runner`: the runner as a Podman quadlet on `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy` → `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy` → `code.chevallier.io:8443` |
| Deploys through | `/opt/quiz/deploy.sh` (forced command) | `/opt/quiz-runner/apps/runner/deploy/deploy.sh` (forced command) |

Neither VM ever builds anything of ours: the two images come from GHCR, built
by CI. The neighbours are not touched — the classroom VM's Caddy already
imported one fragment per service, and the code VM's Caddyfile (owned by
heig-codespace) gained that one `import /etc/caddy/conf.d/*.caddy` line.

## 1. DNS

One A record, `quiz.chevallier.io` → the classroom VM; Caddy obtains the
certificate on its own once it resolves (`dig +short quiz.chevallier.io`). The
runner is reached through the code VM's existing name, `code.chevallier.io`,
on port **8443** — the same certificate, a port of its own so that the
codespace's `:443` site block is not touched. That port must be open in the
Hetzner firewall for the classroom VM's address.

## 2. The application VM (`/opt/quiz`)

```bash
cd /opt && git clone https://github.com/heig-tin-info/heig-quiz.git quiz && cd quiz
mkdir -p secrets backups assets && chown 1000:1000 assets backups    # uid 1000 = `node` in the image
# edu-ID: the client shares the classroom's public JWK, so the same key and kid.
cp /opt/heig-classroom/secrets/eduid-private-key.pem secrets/ && chown 1000:1000 secrets/*.pem && chmod 600 secrets/*.pem
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD, COOKIE_SECRET: openssl rand -base64 32
                  # OIDC_CLIENT_ID: from the SWITCH Resource Registry
                  # RUNNER_TOKEN: openssl rand -hex 32 — the SAME value goes to the code VM
cp Caddyfile /etc/caddy/conf.d/quiz.caddy && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
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
nano /etc/quiz-runner/env      # RUNNER_TOKEN: the value of the application VM
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

Caddy answers 403 to any address but the application VM's, and the runner
answers 401 to any call without the token: two gates, either one enough.

## 4. CI → the two VMs (once)

The `deploy` job of `.github/workflows/ci.yml` SSHes to both VMs with one key,
pinned to a script on each (`command="…",restrict`): the key can ONLY deploy,
never open a shell, even if it leaks. The images stay private on GHCR: the
runner passes its ephemeral token as the SSH "command" (→
`$SSH_ORIGINAL_COMMAND`), which each `deploy.sh` pipes into `docker login` /
`podman login` for the pull — no registry credential is stored on either VM.

```bash
ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@quiz
gh secret set DEPLOY_SSH_KEY --repo heig-tin-info/heig-quiz < ci_deploy          # PRIVATE key, an Actions secret
gh variable set DEPLOY_HOST --repo heig-tin-info/heig-quiz --body classroom.chevallier.io
gh variable set DEPLOY_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 classroom.chevallier.io | awk '{print $2" "$3}')"
gh variable set DEPLOY_RUNNER_HOST --repo heig-tin-info/heig-quiz --body code.chevallier.io
gh variable set DEPLOY_RUNNER_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 code.chevallier.io | awk '{print $2" "$3}')"
# on the application VM
printf 'command="/opt/quiz/deploy.sh",restrict %s\n' "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
# on the runner VM
printf 'command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict %s\n' "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
shred -u ci_deploy
```

Without the secret the job skips cleanly (the images are published anyway);
without `DEPLOY_RUNNER_HOST` only the application is deployed.

## 5. First deployment, and every one after

Push to `main`: checks, two images, two SSH calls. Then:

```bash
curl -s https://quiz.chevallier.io/healthz | jq .              # database, jobs, runner: "up"
ssh root@classroom.chevallier.io 'cd /opt/quiz && docker compose -f compose.prod.yml --env-file .env.prod logs --tail 50 app'
ssh root@code.chevallier.io 'journalctl -u quiz-runner -n 30'   # "podman engine ready", "quiz-runner started"
```

`/healthz` reports the runner `down` when it is unreachable or refuses the
token, and `disabled` when `RUNNER_MODE` is left at `stub`; neither degrades
the platform: a code question stays authorable, playable and releasable, and
its grading is proposed for a manual review (decision D14).

### Manually (if CI is unavailable)

```bash
# application VM
cd /opt/quiz && git pull --ff-only
echo <PAT read:packages> | docker login ghcr.io -u heig-tin-info --password-stdin
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
# runner VM
cd /opt/quiz-runner && echo <PAT read:packages> | podman login ghcr.io -u heig-tin-info --password-stdin
SSH_ORIGINAL_COMMAND= ./apps/runner/deploy/deploy.sh
```

### Rollback

The sha tags stay on GHCR:

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml --env-file .env.prod up -d   # application VM
# runner VM: podman pull ghcr.io/heig-tin-info/quiz-runner:<sha> && podman tag … :latest && systemctl restart quiz-runner
# additive migrations — when in doubt, restore the database (§6).
```

**Never build on the application VM**: an on-VM build makes the host swap and
strangles PostgreSQL — the classroom learned it on 2026-07-10 — and fills the
disk. The runner VM could build, and does build the small Alpine language
images; the runner image itself still comes from CI so that both VMs run the
commit the checks passed on.

## 6. Backups (RPO 24 h, RTO 4 h)

- **A daily provider snapshot of the application VM**, off the machine: the
  whole VM comes back, secrets and volumes included, crash-consistent.
- **A daily `pg_dump -Fc`** from the compose `backup` service into
  `/opt/quiz/backups/` (30-day retention): a logical dump, restorable table
  by table. It lives on the VM it protects.
- `/opt/quiz/assets/` (question images, content-addressed) is part of what to
  copy: `rsync` is enough.
- The runner VM holds nothing to back up: the language images rebuild in a
  minute from `apps/runner/images/`.
- **Before any migration**, take a fresh dump rather than trusting the daily one:

```bash
cd /opt/quiz && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U quiz quiz > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- Restore:

```bash
docker compose -f compose.prod.yml stop app
docker compose -f compose.prod.yml exec -T postgres \
  pg_restore -U quiz -d quiz --clean --if-exists < backups/quiz-<date>.dump
docker compose -f compose.prod.yml start app
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
