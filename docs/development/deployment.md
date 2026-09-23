# Deployment

Production is `https://quiz.chevallier.io`, on two virtual machines and one
repository ([ADR-016](../adr/ADR-016-runner-sur-vm-separee.md)). The
application stack runs on the VM that already hosts heig-classroom, behind
that VM's native Caddy. The code runner runs on the codespace VM,
`code.chevallier.io`, behind that VM's native Caddy, and the API reaches it
over HTTPS with a shared token. Both images are built on GitHub Actions and
pulled from GHCR. Nothing of ours is ever built on either VM.

The operator's runbook is `deploy.md` at the root of the repository, with
the exact commands for the two machines, the DNS record, the secrets, the
CI key and the restore. This page explains the shape of the deployment and
points to that file for the steps; where the two differ, `deploy.md` wins.
The specification's [5.9 Deployment](../spec/05-architecture.md#59-deployment)
describes the earlier single-VM layout and carries an amendment pointing
at ADR-016.

## The two machines

| | `classroom.chevallier.io` | `code.chevallier.io` |
| --- | --- | --- |
| Size | DigitalOcean, 1 CPU, 956 MiB | Hetzner, 2 CPU, 4 GB |
| Already runs | heig-classroom on `:3000`, evaluation-tb on `:3001`, a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/opt/quiz`: the compose stack `app`, `postgres`, `backup` | `/opt/quiz-runner`: the runner as a Podman quadlet |
| Listens on | `app` published on `127.0.0.1:3002` | the runner bound to `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy`, `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy`, `code.chevallier.io:8443` |
| Deploys through | `/opt/quiz/deploy.sh`, forced command | `/opt/quiz-runner/apps/runner/deploy/deploy.sh`, forced command |

Why two: the classroom VM has no Podman and no room for student
compilations next to two PostgreSQL servers and three Node processes,
while the codespace VM already runs the rootful Podman the runner was
written against. The neighbours are not touched. The classroom VM's Caddy
already imported one fragment per service from `/etc/caddy/conf.d/`; the
code VM's `/etc/caddy/Caddyfile`, owned by heig-codespace, gained that one
`import /etc/caddy/conf.d/*.caddy` line and nothing else.

One DNS record, `quiz.chevallier.io`, points at the classroom VM. The
runner is reached through the code VM's existing name on port 8443, so no
record and no certificate are added; `deploy.md` §1 asks for that port to
be open in the Hetzner firewall for the classroom VM's address only.

## The application VM

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, ports 80 and 443, shared with the neighbours | `Caddyfile`, copied to `/etc/caddy/conf.d/quiz.caddy` |
| `app` | container, published on `127.0.0.1:3002` only | `Dockerfile`, image `ghcr.io/heig-tin-info/quiz` |
| `postgres` | container, PostgreSQL 17, volume `pgdata` | `compose.prod.yml` |
| `backup` | container running a daily `pg_dump -Fc` into `./backups/` | `compose.prod.yml` |

`compose.prod.yml` starts these three containers and only those. The
runner is not in the file. Keycloak is a development identity provider and
is not deployed; production authenticates against Switch edu-ID with the
same private key and `kid` as heig-classroom, since the edu-ID client
shares the classroom's public JWK.

The `postgres` service carries the same low-memory tuning as the
classroom's (`shared_buffers=32MB`, `max_connections=40`, no parallel
query): the VM has one CPU and already runs another PostgreSQL.

The Caddy fragment does two things beyond proxying to `localhost:3002`: it
sets the security headers (HSTS, `nosniff`, referrer policy) and it proxies
`/app/api/events` with `flush_interval -1`, so the server-sent event stream
([ADR-005](../adr/ADR-005-sse-sans-websocket.md)) is never buffered. Port
3002 because 3000 and 3001 belong to the neighbours.

The one-time setup is `deploy.md` §2: clone into `/opt/quiz`, create
`secrets/`, `backups/` and `assets/` owned by uid 1000 (the `node` user of
the image), copy the classroom's edu-ID private key, fill `.env.prod` from
`.env.prod.example`, install the Caddy fragment and reload Caddy.

## The runner VM

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, owned by heig-codespace; our site block on `:8443` | `apps/runner/deploy/Caddyfile`, installed as `/etc/caddy/conf.d/quiz-runner.caddy` |
| `quiz-runner` | Podman quadlet, `systemd` service `quiz-runner.service` | `apps/runner/deploy/quiz-runner.container`, installed in `/etc/containers/systemd/` |
| the runner image | `ghcr.io/heig-tin-info/quiz-runner`, pulled by the deploy | `apps/runner/Dockerfile` |
| the seccomp profile | `/etc/quiz-runner/seccomp.json` on the host | `apps/runner/infra/seccomp/runner.json`, installed by the deploy |
| the runner's environment | `/etc/quiz-runner/env`, `chmod 600` | `apps/runner/deploy/env.example` |
| the language images | built on the VM through the rootful socket | `apps/runner/images/build.sh` |

`quiz-runner.container` is a Podman quadlet: `systemd` generates
`quiz-runner.service` from it at `daemon-reload`. The unit runs the CI
image with host networking, `HOST=127.0.0.1` and `PORT=3200`, so the
service is reachable from the host's loopback only and Caddy is the single
way in. Two things come from the host: the rootful socket
`/run/podman/podman.sock` and the seccomp profile. The service itself has
a read-only root, a tmpfs on `/tmp`, no capability, `NoNewPrivileges`
and a 512 MB memory cap. `Pull=never`: the image is pulled by the deploy
script with the CI's token, never at boot.

The seccomp profile is installed on the host on purpose. The runner drives
Podman as a `--remote` client, so `--security-opt seccomp=<path>` names a
file the Podman *server* opens. The deploy copies the repository's profile
to `/etc/quiz-runner/seccomp.json`; the quadlet mounts that same path
read-only into the service and sets `RUNNER_SECCOMP` to it, so the
service's startup check sees the file the server will use.

The Caddy site block `https://code.chevallier.io:8443` reuses the
certificate Caddy already holds for that name, sets HSTS and `nosniff`,
and proxies to `127.0.0.1:3200` for one source address, the classroom
VM's; every other address gets a 403. The runner then requires
`Authorization: Bearer <RUNNER_TOKEN>` on `POST /run` and on `GET /health`,
compared in constant time, and answers 401 otherwise. Two gates, either one
enough on its own. `/health` is guarded on purpose: a token the API got
wrong shows up as a runner `down` in `/healthz`, not as one that says `up`
and refuses every run.

The runner holds one secret, that token, and nothing else: it reaches no
database and passes none of its environment into the sandbox containers,
which invariant 10's closed list still asserts. The sandbox containers are
the ones `apps/runner/README.md` describes, unchanged: `--network none`,
`--userns=auto` (always available on a rootful engine, hence
`RUNNER_USERNS_AUTO=true` in the environment file), nothing mounted.

The one-time setup is `deploy.md` §3: clone into `/opt/quiz-runner`, fill
`/etc/quiz-runner/env` with the same `RUNNER_TOKEN` as the application VM,
add the `import` line to the host Caddyfile once, install the fragment, and
build the language images on the VM with `apps/runner/images/build.sh`
through `/run/podman/podman.sock`. The language images are the runner's
only supply chain: they are never pulled, and a deploy never touches them.

## The two images

`Dockerfile` builds one image for the API and the built SPA together:
a `node:24-slim` build stage installs the workspace with a frozen lockfile,
builds every package sequentially (`--workspace-concurrency=1`), then
`pnpm deploy`s a pruned production tree of `@quiz/api` with the migrations
and `apps/web/dist` alongside. The runtime stage runs as the `node` user
with `STATIC_DIR=/app/web`, `MIGRATE_ON_START=1` and a `HEALTHCHECK` on
`/healthz`. The API applies the migrations at startup, then serves the SPA
from `/app/web`.

The runner image (`apps/runner/Dockerfile`) is smaller and different in
one respect: it contains no container engine, only the static
`podman-remote` client of a pinned version (5.7.0), verified by checksum,
and it runs as root on purpose because the socket it drives is root-owned.
The pinned version must match the engine of the code VM; upgrading the
VM's Podman means bumping the pin.

## Continuous deployment

`.github/workflows/ci.yml` has three jobs:

1. **checks**: `pnpm build`, `pnpm typecheck`, `pnpm test` and the
   runner's unit suite, on every push and pull request.
2. **image**, on a push to `main` only: both images are built with
   `docker/build-push-action` and pushed to GHCR twice each, as `:latest`
   and as `:<commit sha>`. The sha tags are what a rollback uses.
3. **deploy**: one SSH call per VM, with the private key in the
   `DEPLOY_SSH_KEY` secret and a pinned host key for each machine
   (`DEPLOY_HOST` and `DEPLOY_HOST_KEY` for the application VM,
   `DEPLOY_RUNNER_HOST` and `DEPLOY_RUNNER_HOST_KEY` for the runner VM).
   The job passes its ephemeral `GITHUB_TOKEN` as the SSH command. When the
   secret or `DEPLOY_HOST` is missing, the job prints a notice and does
   nothing, so the pipeline stays green until the key is provisioned; when
   `DEPLOY_RUNNER_HOST` is missing, only the application is deployed. A
   concurrency group serialises the deploys.

On each VM the same CI key is pinned to that VM's script in
`/root/.ssh/authorized_keys`, with a forced command and `restrict`:

```
command="/opt/quiz/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy@quiz
```

Whatever command the client asks for, the server runs the pinned script
instead, so the key can only deploy and never open a shell, even if it
leaks. The token the workflow sent arrives in `$SSH_ORIGINAL_COMMAND` and
is piped straight to `docker login` or `podman login` with
`--password-stdin`, never evaluated. The token expires with the workflow
run; no registry credential is stored on either VM. On the runner VM,
root's Podman auth file lives under `/run`, so nothing survives a reboot.

The two scripts share one more step. `git pull --ff-only` rewrites the
script while bash is still reading the old copy, so a deploy that changes
the deploy steps would run the previous ones. Each script therefore
compares `HEAD` before and after the pull and, when it moved, hands over to
the pulled copy exactly once (`exec "$0"` with `QUIZ_DEPLOY_REEXEC=1` set
and the token cleared, the login being already done).

Then they diverge:

- **application VM**: `docker compose pull app` (only our image; `postgres`
  and `backup` are public images compose already has, and the login stays
  scoped to what the token was issued for; `--ignore-pull-failures` is
  deliberately not used, a missing image must stop the deploy rather than
  half-restart the stack), `up -d`, prune dangling images, print the
  deployed commit;
- **runner VM**: `podman pull` of the runner image, install the seccomp
  profile, the quadlet and the Caddy fragment from the checkout,
  `caddy validate`, `systemctl daemon-reload`, restart
  `quiz-runner.service`, reload Caddy, prune, print the deployed commit.

`deploy.md` §4 has the one-time setup (the key pair, the Actions secret and
variables, the two `authorized_keys` lines) and §5 the manual deployment
for a day CI is unavailable: a PAT with `read:packages` for the login, then
the same pull and restart on each VM. `.github/workflows/image-artifact.yml`
is a keyless fallback for the application image only: run by hand, it
builds the image and publishes it as a workflow artifact to
`gh run download` and `docker load` on the VM.

!!! warning "Never build on the application VM"

    The classroom VM is small. A local build makes the host swap and
    starves PostgreSQL, and fills the disk with builder cache; `deploy.md`
    records the incident that made this a rule. `deploy.sh` only pulls. The
    runner VM does build the small Alpine language images, on purpose; the
    runner image itself still comes from CI, so that both VMs run the commit
    the checks passed on.

## Configuration

### The application side

The `app` container reads `.env.prod` (from `.env.prod.example`,
`chmod 600`), plus a few values `compose.prod.yml` sets itself:
`NODE_ENV=production`, `DATABASE_URL` built from `POSTGRES_PASSWORD`,
`PUBLIC_URL` and `ASSETS_DIR`. Every variable is validated at startup by
`apps/api/src/config.ts`, which refuses to start on an invalid or
dangerous configuration.

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
| `SESSION_TTL_HOURS` | `12` | idle timeout with sliding expiry, at most 720 |
| `TRUSTED_PROXIES` | default `loopback,172.16.0.0/12` | the addresses the API accepts `X-Forwarded-For` from: native Caddy on loopback and the Docker bridge; `req.ip` feeds the room restriction and the attempt journal, so never list a range a student machine can sit on |
| `METRICS_TOKEN` | a bearer token for Prometheus | empty leaves `/metrics` to an admin session; the endpoint is never public |
| `RUNNER_MODE`, `RUNNER_URL` | `http`, `https://code.chevallier.io:8443` | `http` without a URL is refused; `stub` disables the runner, see below |
| `RUNNER_TOKEN` | `openssl rand -hex 32`, the same value as `/etc/quiz-runner/env` on the runner VM | sent as `Authorization: Bearer` on every call; required under `NODE_ENV=production` when `RUNNER_MODE=http`, the process does not start without it |
| `RUNNER_TIMEOUT_MS` | default `30000` | wall-clock budget of one runner call |
| `LOG_LEVEL`, `WORKER_MODE` | `info`, `all` | `web`/`worker` would split the roles without a code change ([ADR-001](../adr/ADR-001-monolithe-modulaire.md)) |

The uploaded question images live in `./assets` on the host, mounted at
`/app/assets` (`ASSETS_DIR`); the store is content-addressed by sha256, so
a backup of it is a plain copy.

Secrets travel through the environment or a mounted file and are never in
git ([ADR-010](../adr/ADR-010-stockage-secrets.md)). An encrypted copy of
`.env.prod` and of `secrets/` in a vault (`age`) is a precondition of the
recovery objective.

### The runner side

The service reads `/etc/quiz-runner/env` (from
`apps/runner/deploy/env.example`, root only, `chmod 600`) through the
quadlet's `EnvironmentFile`, plus what the quadlet sets. Everything is
validated at startup by `apps/runner/src/config.ts`.

| Variable | Production value | Notes |
| --- | --- | --- |
| `RUNNER_TOKEN` | the value of the application VM | required under `NODE_ENV=production`: the service refuses to start without it; the only secret the runner holds, never passed into a sandbox container |
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
its grading is proposed for a manual review (decision D14). `/healthz` then
reports the runner as `disabled`, a configuration and not a failure.

## Health and metrics

`GET /healthz` answers `200 {"status":"ok"}` when the database answers
`SELECT 1`, and `503 {"status":"degraded"}` otherwise. Its `checks` object
reports `database`, `jobs` (whether pg-boss is up) and `runner`, which is
`up`, `down` (configured but unreachable, or refusing the token) or
`disabled` (`RUNNER_MODE=stub`). The runner never decides the overall
status: an unreachable runner only degrades code grading, and a container
must not be restarted for that. The container `HEALTHCHECK` and the
external probe recommended in `deploy.md` §7 (60 s, from outside) both hit
this route.

After a deploy, `deploy.md` §5 checks three things:

```bash
curl -s https://quiz.chevallier.io/healthz | jq .              # database, jobs, runner: "up"
ssh root@classroom.chevallier.io 'cd /opt/quiz && docker compose -f compose.prod.yml --env-file .env.prod logs --tail 50 app'
ssh root@code.chevallier.io 'journalctl -u quiz-runner -n 30'
```

`GET /metrics` is a Prometheus endpoint with the default collectors and a
`quiz_database_up` gauge. It is never public: a request with
`Authorization: Bearer $METRICS_TOKEN` passes when the token is set, and any
other request must carry an admin session. Logs are `docker compose logs -f
app` on one VM and `journalctl -u quiz-runner -f` on the other.

## Backups

Two layers, detailed in `deploy.md` §6 (RPO 24 h, RTO 4 h):

- a daily snapshot of the whole application VM by the hosting provider,
  taken off the machine, which covers losing the machine outright;
- a daily logical dump by the `backup` service: `pg_dump -Fc` into
  `./backups/quiz-<date>.dump`, 30 days kept, restorable table by table.
  It lives on the VM it protects; the off-VM copy (`rclone` to an object
  store) is listed there as still to wire.

Before any migration, take a fresh dump by hand rather than trusting the
daily one; the command and the `pg_restore` recipe are in `deploy.md` §6.

What to back up besides PostgreSQL: `./assets` (the uploaded images,
content-addressed, a plain copy suffices) and `./secrets` (through the
vault, never through the backup directory). The runner VM holds nothing to
back up: the language images rebuild in a minute from
`apps/runner/images/`, and its environment file is one line, the token,
which the vault copy of `.env.prod` also holds. In development the
equivalent of the database is the directory `apps/api/.data/pglite`, which
is only ever copied to keep a state, never deployed.

## Rollback

Every image is also tagged with the commit sha it was built from, and the
sha tags stay on GHCR. `compose.prod.yml` reads the tag from `IMAGE_TAG`
(default `latest`):

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml \
  --env-file .env.prod up -d
```

On the runner VM the quadlet runs `:latest` with `Pull=never`, so a
rollback is a pull of the sha tag, a retag to `:latest` and
`systemctl restart quiz-runner`, as `deploy.md` §5 prescribes.

Migrations are additive, so an older image runs against a newer schema;
when in doubt, restore the pre-migration dump first. Note that the next
push to `main` runs both deploy scripts, which pull `latest` again and undo
the rollback, so a rollback is a way to buy time, not a way to hold a
version.
