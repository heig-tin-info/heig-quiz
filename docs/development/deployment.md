# Deployment

Production is one virtual machine, one PostgreSQL, one repository
([ADR-009](../adr/ADR-009-deploiement-vm-compose.md)). Caddy runs natively
on the host and terminates TLS; Docker Compose runs the application, the
runner, PostgreSQL and a backup loop; the two application images are built
on GitHub Actions and pulled from GHCR. Nothing is ever built on the VM.

The operator's runbook is `deploy.md` at the root of the repository, with
the exact commands for creating the VM, installing Docker, Caddy and Podman,
placing the secrets and restoring a backup. This page explains the shape of
the deployment and points to that file for the steps; where the two differ,
`deploy.md` wins.

## The pieces

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, ports 80 and 443 | `Caddyfile`, copied to `/etc/caddy/Caddyfile` |
| `app` | container, published on `127.0.0.1:3000` only | `Dockerfile`, image `ghcr.io/heig-tin-info/quiz` |
| `runner` | container on the internal compose network, no published port | `apps/runner/Dockerfile`, image `ghcr.io/heig-tin-info/quiz-runner` |
| `postgres` | container, PostgreSQL 17, volume `pgdata` | `compose.prod.yml` |
| `backup` | container running a daily `pg_dump -Fc` into `./backups/` | `compose.prod.yml` |
| Podman | rootful service on the host, socket `/run/podman/podman.sock` | `deploy.md` §5b |

`compose.prod.yml` starts the four containers and only those. Keycloak is a
development identity provider and is not deployed; production authenticates
against Switch edu-ID.

The Caddyfile does two things beyond proxying to `localhost:3000`: it sets
the security headers (HSTS, `nosniff`, referrer policy) and it proxies
`/app/events` with `flush_interval -1`, so the server-sent event stream
([ADR-005](../adr/ADR-005-sse-sans-websocket.md)) is never buffered.

## The application image

`Dockerfile` builds one image for the API and the built SPA together:
a `node:24-slim` build stage installs the workspace with a frozen lockfile,
builds every package sequentially (`--workspace-concurrency=1`, with Node
allowed to spill into swap), then `pnpm deploy`s a pruned production tree of
`@quiz/api` with the migrations and `apps/web/dist` alongside. The runtime
stage runs as the `node` user with `STATIC_DIR=/app/web`,
`MIGRATE_ON_START=1` and a `HEALTHCHECK` on `/healthz`. The API applies the
migrations at startup, then serves the SPA from `/app/web`.

The runner image (`apps/runner/Dockerfile`) is smaller and different in
one respect: it contains no container engine, only the static
`podman-remote` client of a pinned version, verified by checksum, and it
runs as root on purpose because the socket it drives is root-owned. The
Podman version pinned there must match the engine installed on the VM.

## Continuous deployment

`.github/workflows/ci.yml` has three jobs:

1. **checks**: `pnpm build`, `pnpm typecheck`, `pnpm test` and the
   runner's unit suite, on every push and pull request.
2. **image**, on a push to `main` only: both images are built with
   `docker/build-push-action` and pushed to GHCR twice each, as `:latest`
   and as `:<commit sha>`. The sha tags are what a rollback uses.
3. **deploy**: the job opens an SSH connection to `root@$DEPLOY_HOST` with
   the private key in the `DEPLOY_SSH_KEY` secret and a pinned host key
   (`DEPLOY_HOST_KEY`), passing its ephemeral `GITHUB_TOKEN` as the SSH
   command. When the secret or the host variable is missing, the job prints
   a notice and does nothing, so the pipeline stays green until the key is
   provisioned.

On the VM, the CI key is pinned to `deploy.sh` in `/root/.ssh/authorized_keys`
with a forced command and `restrict`:

```
command="/opt/quiz/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy@quiz
```

Whatever command the client asks for, the server runs `deploy.sh` instead,
so the key can only deploy and never open a shell, even if it leaks. The
token the workflow sent arrives in `$SSH_ORIGINAL_COMMAND`; `deploy.sh`
pipes it to `docker login ghcr.io --password-stdin`, pulls the two images
(`pull app runner`, deliberately without `--ignore-pull-failures`: a missing
image must stop the deploy, not half-restart the stack), runs `up -d`,
prunes dangling images and prints the deployed commit. The token expires
with the workflow run; no registry credential is stored on the VM.

`deploy.md` §6 has the one-time setup (the key pair, the Actions secret,
the `authorized_keys` line) and the manual deployment for a day CI is
unavailable. `.github/workflows/image-artifact.yml` is a keyless fallback:
run by hand, it builds the application image and publishes it as a workflow
artifact to `gh run download` and `docker load` on the VM.

!!! warning "Never build on the VM"

    The production VM is small. A local build makes the host swap and
    starves PostgreSQL, and fills the disk with builder cache. `deploy.sh`
    only pulls; `deploy.md` records the incident that made this a rule.

## Configuration

The container reads `.env.prod` (from `.env.prod.example`, `chmod 600`),
plus a few values `compose.prod.yml` sets itself: `NODE_ENV=production`,
`DATABASE_URL` built from `POSTGRES_PASSWORD`, `PUBLIC_URL`, and
`RUNNER_MODE`/`RUNNER_URL` pointing at the `runner` service. Every
variable is validated at startup by `apps/api/src/config.ts`, which refuses
to start on an invalid or dangerous configuration.

| Variable | Production value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://quiz:<password>@postgres:5432/quiz`, set by compose | a `pglite://` URL is refused under `NODE_ENV=production` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32` | used by the `postgres`, `backup` and `app` services |
| `COOKIE_SECRET` | `openssl rand -base64 32` | signs the login state cookies; the `change-me` placeholder is refused |
| `AUTH_DEV_LOGIN` | unset | `1` is refused: the process does not start |
| `PUBLIC_URL` | `https://quiz.example.ch`, set by compose | base of the OIDC redirect URI; `WEB_URL` is left empty because the monolith serves the SPA itself |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | the Switch edu-ID issuer and the issued client id | the dev defaults point at the local Keycloak |
| `OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID` | `secrets/eduid-private-key.pem`, `quiz-eduid-2026` | `private_key_jwt` client authentication, the method SWITCH recommends: a PKCS8 key whose public JWK is registered in the Resource Registry; `./secrets` is mounted read-only into the container |
| `OIDC_CLIENT_SECRET` | unset when a private key is used | `client_secret` authentication otherwise; the `not-for-production` placeholder is refused |
| `SUPER_ADMIN_EMAIL` | one address | the only account managed through the environment; teachers are managed from the admin screen |
| `SESSION_TTL_HOURS` | `12` | idle timeout with sliding expiry, at most 720 |
| `TRUSTED_PROXIES` | default `loopback,172.16.0.0/12` | the addresses the API accepts `X-Forwarded-For` from: native Caddy on loopback and the Docker bridge; `req.ip` feeds the room restriction and the attempt journal, so never list a range a student machine can sit on |
| `METRICS_TOKEN` | a bearer token for Prometheus | empty leaves `/metrics` to an admin session; the endpoint is never public |
| `RUNNER_MODE`, `RUNNER_URL` | `http`, `http://runner:3200`, set by compose | remove both and the platform runs in `stub` mode, see below |
| `RUNNER_TIMEOUT_MS` | default `30000` | wall-clock budget of one runner call |
| `RUNNER_CONCURRENCY`, `RUNNER_QUEUE_MAX` | default `4`, `32` | passed to the `runner` service |
| `LOG_LEVEL`, `WORKER_MODE` | `info`, `all` | `web`/`worker` would split the roles without a code change ([ADR-001](../adr/ADR-001-monolithe-modulaire.md)) |

The uploaded question images live in `./assets` on the host, mounted at
`/app/assets` (`ASSETS_DIR`); the store is content-addressed by sha256, so
a backup of it is a plain copy.

Secrets travel through the environment or a mounted file and are never in
git ([ADR-010](../adr/ADR-010-stockage-secrets.md)). An encrypted copy of
`.env.prod` and of the edu-ID key in a vault is a precondition of the
recovery objective.

## The runner in production

The `runner` service holds no secret, reaches no database and is never
published: it sits on the internal compose network, Caddy never routes to
it, and the only thing it gets from the host is the rootful Podman socket
mounted at `/run/podman/podman.sock`. The containers it starts mount
nothing at all.

Two host-side prerequisites, both in `deploy.md` §5b: install Podman and
enable `podman.socket` as root, and build the language images on the VM
with `apps/runner/images/build.sh` through that socket. The images are the
runner's only supply chain: it never pulls from a registry, and the sandbox
containers have no network.

Checks:

```bash
docker compose -f compose.prod.yml exec app curl -sf http://runner:3200/health
curl -sf https://quiz.example.ch/healthz | jq .checks.runner     # "up"
```

A VM without Podman still runs the whole platform: drop the `runner`
service and the two `RUNNER_*` variables of the `app` service, and code
questions stay authorable, playable and releasable, with their grading
proposed for a manual review (decision D14).

## Health and metrics

`GET /healthz` answers `200 {"status":"ok"}` when the database answers
`SELECT 1`, and `503 {"status":"degraded"}` otherwise. Its `checks` object
reports `database`, `jobs` (whether pg-boss is up) and `runner`, which is
`up`, `down` (configured but unreachable) or `disabled` (`RUNNER_MODE=stub`).
The runner never decides the overall status: an unreachable runner only
degrades code grading, and a container must not be restarted for that. The
container `HEALTHCHECK` and the external probe recommended in `deploy.md`
§9 both hit this route.

`GET /metrics` is a Prometheus endpoint with the default collectors and a
`quiz_database_up` gauge. It is never public: a request with
`Authorization: Bearer $METRICS_TOKEN` passes when the token is set, and any
other request must carry an admin session.

## Backups

Two layers, detailed in `deploy.md` §7:

- a daily snapshot of the whole VM by the hosting provider, taken off the
  machine, which covers losing the machine outright;
- a daily logical dump by the `backup` service: `pg_dump -Fc` into
  `./backups/quiz-<date>.dump`, 30 days kept, restorable table by table.
  It lives on the VM it protects; the off-VM copy (`rclone` to an object
  store) is listed there as still to wire.

Before any migration, take a fresh dump by hand rather than trusting the
daily one; the command and the `pg_restore` recipe are in `deploy.md` §7.

What to back up besides PostgreSQL: `./assets` (the uploaded images,
content-addressed, a plain copy suffices) and `./secrets` (through the
vault, never through the backup directory). In development the equivalent
of the database is the directory `apps/api/.data/pglite`, which is only
ever copied to keep a state, never deployed.

## Rollback

Every image is also tagged with the commit sha it was built from, and the
sha tags stay on GHCR. `compose.prod.yml` reads the tag from `IMAGE_TAG`
(default `latest`) for both images:

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml \
  --env-file .env.prod up -d
```

Migrations are additive, so an older image runs against a newer schema;
when in doubt, restore the pre-migration dump first. Note that the next
push to `main` runs `deploy.sh`, which pulls `latest` again and undoes the
rollback, so a rollback is a way to buy time, not a way to hold a version.
